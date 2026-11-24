---
name: make-demo-video
description: 把一個 repo、網址、PDF 或一段文字變成一支 demo 影片（MP4＋GIF，可放進 README）。流程是四步：讀素材寫腳本 → 挑風格 → 排分鏡 → 算圖輸出，影片由瀏覽器逐格算圖、ffmpeg 合成，同一份分鏡表換風格就能重出。當使用者說「做 demo 影片」「幫我做 README 動圖」「把這個專案做成影片」「做一支介紹影片」「把這篇文章做成短片」，或直接呼叫 /make-demo-video 時使用。
---

# make-demo-video

把素材變成一支 15–40 秒、有字幕的 demo 影片。影片不是錄螢幕，而是一份 **分鏡表（storyboard.json）＋ 一份風格（style）** 算出來的：

- 改一句字幕、換一個風格，只要改 JSON 再算一次，大約 20 秒。
- 分鏡表是純文字，可以 commit、diff、code review。

## 開始前

第一次使用時，在本 skill 的資料夾裝相依套件（之後不用再裝）：

```bash
cd <本 skill 的資料夾> && [ -d node_modules ] || npm install --no-fund --no-audit
```

需要 Node 18 以上與 Google Chrome（沒有 Chrome 時改跑 `npx playwright install chromium`）。ffmpeg 已隨套件附上，不用另外裝。

以下 `<skill>` 代表本 skill 的資料夾，`<out>` 代表輸出資料夾。輸出資料夾預設放在使用者目前所在專案的 `docs/demo/`；目前不在任何專案裡時，問使用者要放哪裡。

## 四步流程

照順序做，每一步結束時用一句話告訴使用者做了什麼。

### ① 讀素材，寫腳本

依素材種類讀內容：

| 素材 | 怎麼讀 |
|---|---|
| 目前所在的 repo 或本機路徑 | README、`package.json`、主要頁面與 API 的檔案，找出「這是什麼、給誰用、三個亮點」 |
| GitHub 網址 | `gh repo view <owner/repo>` 與 README；沒有 gh 就用網頁抓取 |
| 網站網址 | 網頁抓取讀文字，再用 `node <skill>/scripts/capture.mjs <網址> --out <out> --shots 2` 截圖 |
| PDF、文章、一段文字 | 直接讀，整理成重點 |

`<out>` 裡已經有 `shot-*.png` 時直接沿用，不要重新截圖（使用者可能先備好畫面，避開網路不穩或線上資料空白）。截圖後先看圖；畫面上的數字是 `--`、空白或載入中時，告訴使用者，不要把那一塊當成推近重點。

寫出 4–7 句腳本，一句對應一幕。原則：

- 第一句是「看的人得到什麼」，不是產品名稱。
- 每句 20 字以內，影片上要能一眼讀完。
- 只寫素材裡讀得到的事實，不要編數字或功能。

### ② 挑風格

用 AskUserQuestion 問一題，選項用下面「內建風格」表的名稱與說明，每個選項的 `preview` 放該風格的色票與氣氛（例如 `底 #faf9f4・字 #1c1c1c・重點 #ffe14d｜劇本紙、螢光筆`）。最多四個選項，依素材挑最合適的三個內建風格，第四個固定是「從素材定義風格」。

使用者已經在指令裡指定風格時，跳過這題。

**從素材定義風格**：從素材裡取色與氣氛（網站的主色與字體、品牌色、使用者提供的圖片或描述），照「風格檔格式」寫一份 `<out>/style.json`，告訴使用者取了哪幾個顏色、從哪裡取的。文字與底色的對比要夠（深底配淺字或反過來），`accentText` 要能在 `accent` 色塊上讀得清楚；`accent` 太淺、拿來當字會看不見時，加一個較深的 `accentInk`。

### ③ 排分鏡

把腳本排成 `<out>/storyboard.json`（格式見下）。原則：

- 總長 15–40 秒，每幕 3–6 秒；字多的幕給長一點。
- 第一幕 `title`，最後一幕 `outro`；有網址時 `outro` 會自動放 QR code。
- 有截圖就用 `browser` 幕，用 `focus` 推近到重點區塊、用 `clicks` 點出要看的地方。座標都是 0–1 的比例。
- 要秀指令或 AI 對話用 `terminal`，要秀設定檔或程式碼用 `file`，要列重點用 `points`（最多 4 點）。
- 字幕與標題裡用 `**粗體**` 標出最重要的 1–3 個字，會畫成重點色。

### ④ 算圖輸出

```bash
node <skill>/scripts/render.mjs --storyboard <out>/storyboard.json --style <風格 id 或 style.json 的路徑> --out <out>
```

完成後會印出 MP4、GIF、結果頁的路徑，並在 macOS 上自動打開結果頁。算圖成功就直接回報，不要再抽格、截圖或讀影片檢查（render.mjs 已經驗過分鏡表，使用者正在看結果頁）。告訴使用者：

1. 檔案在哪裡、花了幾秒。
2. 要放進 README 的寫法：`[![demo](docs/demo/demo.gif)](<網址>)`。
3. 想改哪裡就說，例如「第三幕字幕改短」「換成霓虹風格」，改完重跑同一行指令即可。

算圖失敗時，錯誤訊息會指出哪一幕的哪個欄位有問題，修正分鏡表後重跑；不要改 `player/` 或 `scripts/` 來繞過檢查。

### 其他指令

- **同一份分鏡表出多種風格的合輯**（開場或比較風格用）：
  `node <skill>/scripts/reel.mjs --storyboard <out>/storyboard.json --styles screenplay,terminal,neon --from 1 --seconds 5`
- **多個專案 × 多種風格的合輯**：寫一份 `reel.json` 列出每一段，再跑 `node <skill>/scripts/reel.mjs --plan reel.json`。
  `{ "seconds": 5, "clips": [{ "storyboard": "../a/storyboard.json", "style": "neon", "from": 3 }] }`，路徑相對於 reel.json，`style` 可以是內建 id 或風格檔路徑。
- **不算圖先預覽**：用瀏覽器打開 `<out>/demo.player.html`，會循環播放。

## 內建風格

| id | 名稱 | 適合 |
|---|---|---|
| `screenplay` | 紙卡劇本 | 深藍桌面上的劇本紙、黃色螢光筆。說故事、活動預告 |
| `studio` | 暖白解說 | 米白底、珊瑚橘重點、圓角卡片。產品介紹、教學、一般大眾 |
| `terminal` | 終端機 | 黑底綠字、掃描線、逐字跳出。開發工具、CLI、技術分享 |
| `neon` | 霓虹 | 深紫夜色、發光洋紅、側滑轉場。活動、遊戲、舞台感開場 |
| `blueprint` | 藍圖 | 工程藍底、白色格線。架構、流程、系統類主題 |

## 分鏡表格式

```json
{
  "title": "影片標題（結果頁用）",
  "aspect": "16:9",
  "url": "https://github.com/you/project",
  "scenes": [
    { "kind": "title", "seconds": 3, "kicker": "小標", "heading": "主標，**重點**", "sub": "副標" },
    { "kind": "browser", "seconds": 5, "address": "example.com", "image": "shot-1.png",
      "focus": [{ "at": 0, "x": 0.5, "y": 0.5, "zoom": 1 }, { "at": 0.6, "x": 0.3, "y": 0.4, "zoom": 1.6 }],
      "clicks": [{ "at": 0.4, "x": 0.3, "y": 0.4 }],
      "caption": "字幕" },
    { "kind": "terminal", "seconds": 5, "name": "Claude Code",
      "lines": ["會逐字打出來的指令", { "type": "out", "text": "輸出", "highlight": true }] },
    { "kind": "file", "seconds": 4, "name": "style.md", "lines": ["一行", { "text": "要標亮的一行", "highlight": true }] },
    { "kind": "points", "seconds": 4, "heading": "三個重點", "items": ["一", "二", "三"] },
    { "kind": "outro", "seconds": 3, "heading": "原始碼在這裡", "sub": "掃描 QR code" }
  ]
}
```

- `aspect`：`16:9`（預設）、`9:16`（直式短影音）、`1:1`。
- 每一幕都可以加 `caption`（字幕）與 `step`（上方標籤，例如 `{ "n": 1, "name": "分鏡表" }`）。
- `image` 的路徑相對於分鏡表所在的資料夾。
- `focus` 與 `clicks` 的 `at` 是這一幕的進度（0 開頭、1 結尾），`x`、`y` 是圖片上的位置比例。

## 風格檔格式

```json
{
  "id": "my-brand",
  "name": "品牌風格",
  "description": "一句話描述氣氛",
  "colors": { "bg": "#fff", "surface": "#fff", "text": "#111", "muted": "#666",
              "accent": "#e2694a", "accentText": "#fff", "border": "#ddd",
              "accentInk": "（選填）accent 當文字用時的顏色", "backdrop": "（選填，paper 裝飾的桌面色）" },
  "fonts": { "display": "標題字體", "body": "內文字體", "mono": "等寬字體" },
  "radius": 12,
  "shadow": "CSS box-shadow，或 none",
  "motion": { "enter": "rise | pop | step", "duration": 0.4, "transition": "fade | cut | slide" },
  "decor": "none | paper | scanlines | grid | glow",
  "caption": "plain | bar | highlight"
}
```

字體清單一定要以中文字體收尾（例如 `"PingFang TC", "Noto Sans TC", sans-serif`），否則中文會退回系統預設字體。
