// capture.mjs --click 與錨點的位置：純邏輯直接測；整條流程開一個本機網頁、真的開瀏覽器跑一次（找不到瀏覽器就跳過）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseSteps, pickTarget } from "./page-actions.mjs";
import { launchBrowser } from "./lib.mjs";

const run = promisify(execFile);
const CAPTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "capture.mjs");

test("parseSteps：用 > 分開，type: 是打字", () => {
  assert.deepEqual(parseSteps("搜尋城市 > type:台北 > 台北市"), [{ click: "搜尋城市" }, { type: "台北" }, { click: "台北市" }]);
  assert.deepEqual(parseSteps(" 複製連結 "), [{ click: "複製連結" }]);
  assert.deepEqual(parseSteps("搜尋 > TYPE： New York"), [{ click: "搜尋" }, { type: "New York" }]);
});

test("parseSteps：空的、type 沒寫字、第一步就 type 都擋下來", () => {
  assert.throws(() => parseSteps(undefined), /沒有寫要點什麼/);
  assert.throws(() => parseSteps(" > "), /沒有寫要點什麼/);
  assert.throws(() => parseSteps("搜尋 > type:"), /type: 後面要寫/);
  assert.throws(() => parseSteps("type:台北"), /第一步要先點/);
});

test("pickTarget：字完全相同的優先，再來是能點的、最內層的", () => {
  const c = [
    { index: 0, text: "台北市 一週預報 台北市", clickable: false, area: 90000 },
    { index: 1, text: "台北市", clickable: false, area: 900 },
    { index: 2, text: "台北市", clickable: true, area: 3000 },
    { index: 3, text: "新北市", clickable: true, area: 3000 },
  ];
  assert.equal(pickTarget(c, "台北市").index, 2);
  assert.equal(pickTarget(c, "台北 市！").index, 2, "忽略空白與標點");
  assert.equal(pickTarget(c, "一週預報").index, 0, "沒有完全相同的就找包含這段字的");
  assert.equal(pickTarget(c, "高雄"), null);
  assert.equal(pickTarget(c, " "), null);
});

test("pickTarget：都只是包含時，字越短越好", () => {
  const c = [
    { index: 0, text: "複製這頁的連結給朋友", clickable: true, area: 100 },
    { index: 1, text: "複製連結", clickable: false, area: 100 },
  ];
  assert.equal(pickTarget(c, "複製").index, 1);
});

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;font:16px sans-serif} header{position:fixed;top:0;left:0;right:0;height:50px;background:#eee}
main{padding:80px 40px} li{cursor:pointer;list-style:none;padding:8px} .spacer{height:1500px}</style>
<header><a href="#about" style="margin-left:900px">關於我們</a></header>
<main>
  <h1>天氣看板</h1>
  <input placeholder="搜尋城市" style="width:300px">
  <ul id="list"></ul>
  <section id="result"></section>
  <div style="height:60px;overflow:auto"><button style="display:block;height:40px">選單第一項</button><button style="display:block;height:40px">選單第二項</button><button style="display:block;height:40px">捲到才看得到</button></div>
  <div class="spacer"></div>
</main>
<script>
  const input = document.querySelector("input");
  input.addEventListener("input", () => {
    document.getElementById("list").innerHTML = input.value.includes("台北") ? "<li>台北市</li><li>新北市</li>" : "";
  });
  document.getElementById("list").addEventListener("click", (e) => {
    document.getElementById("result").innerHTML = "<h2>" + e.target.textContent + " 一週預報</h2><button>複製連結</button>";
  });
</script>`;

let browserOk = false;
try {
  await (await launchBrowser()).close();
  browserOk = true;
} catch {
  // 沒有瀏覽器的機器跳過整條流程的測試
}

test("capture --click：照步驟操作後截圖，錨點記下位置與能不能點", { skip: !browserOk && "找不到瀏覽器", timeout: 60000 }, async () => {
  const server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = await mkdtemp(path.join(tmpdir(), "capture-click-"));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const { stdout } = await run("node", [CAPTURE, url, "--out", dir, "--full", "--shots", "1", "--name", "step-2", "--click", "搜尋城市 > type:台北 > 台北市"]);
    assert.match(stdout, /點了「搜尋城市」/);
    assert.match(stdout, /點了「台北市」/);
    assert.ok(existsSync(path.join(dir, "step-2-full.png")));
    assert.ok(existsSync(path.join(dir, "step-2-1.png")));

    const data = JSON.parse(await readFile(path.join(dir, "step-2-full.json"), "utf8"));
    assert.equal(data.width, 1280);
    assert.equal(data.scale, 1);
    const find = (text) => data.anchors.find((a) => a.text === text);
    const result = find("台北市 一週預報");
    assert.ok(result, "點了之後才出現的標題要在錨點裡");
    // 標題是區塊元素（跟版面一樣寬），box 要量字本身：遠比版面窄
    assert.ok(result.box[2] < 400, `標題的 box 是字的寬度，不是整行：${result.box}`);
    assert.ok(!result.click);
    const copy = find("複製連結");
    assert.equal(copy.click, true, "按鈕標成能點");
    const [x, y, w, h] = copy.box;
    assert.ok(x >= 40 && y > result.box[1] && w > 0 && h > 0, `按鈕在標題下面：${copy.box}`);
    assert.ok(Math.abs(copy.y - y / data.height) < 0.001, "y 比例跟 box 對得上");
    // 固定在頂端的導覽列：連結字很小也要收，而且位置在頁首
    const nav = find("關於我們");
    assert.equal(nav.click, true);
    assert.ok(nav.box[0] >= 900 && nav.box[1] < 50, `導覽列連結在頁首：${nav.box}`);
    assert.equal(find("搜尋城市").click, true);
    // 捲動容器裡露出一部分的收，整個被遮住的不收
    assert.ok(find("選單第二項"), "露出一部分的選項要收");
    assert.equal(find("捲到才看得到"), undefined, "被捲動容器整個遮住的不收");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture --click：找不到字時說畫面上有哪些能點的", { skip: !browserOk && "找不到瀏覽器", timeout: 60000 }, async () => {
  const server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = await mkdtemp(path.join(tmpdir(), "capture-click-"));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const err = await run("node", [CAPTURE, url, "--out", dir, "--shots", "1", "--click", "高雄市"]).catch((e) => e);
    assert.equal(err.code, 1);
    assert.match(err.stderr, /找不到「高雄市」/);
    assert.match(err.stderr, /關於我們/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
