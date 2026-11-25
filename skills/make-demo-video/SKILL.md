---
name: make-demo-video
description: 把一個 repo、網址、PDF 或一段文字變成一支 demo 影片（MP4＋GIF，可放進 README）。流程是四步：讀素材寫腳本 → 挑風格 → 排分鏡 → 算圖輸出，影片由瀏覽器逐格算圖、ffmpeg 合成，同一份分鏡表換風格就能重出。當使用者說「做 demo 影片」「幫我做 README 動圖」「把這個專案做成影片」「做一支介紹影片」「把這篇文章做成短片」，或直接呼叫 /make-demo-video 時使用。
---

# make-demo-video

把素材變成一支 10–40 秒、有字幕的 demo 影片；放 README 的預設是 12–20 秒的快節奏短片。影片不是錄螢幕，而是一份 **分鏡表（storyboard.json）＋ 一份風格（style）** 算出來的：

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

照順序做。使用者常常是在旁邊看著終端機（甚至是台下的觀眾），所以進度要一眼看得出來：

- **四行進度一行都不能少，而且要依序各自輸出**：做完一步就輸出那一步的進度行，再開始下一步的工具呼叫。不要把四步留到最後一次總結。
  - `① 腳本`：寫好 `script.md` 之後、寫 `storyboard.json` **之前**輸出，並把腳本逐句列出來。
  - `② 風格`：使用者在指令裡指定了風格、跳過提問時，**也要輸出**。
  - `③ 分鏡`：寫好 `storyboard.json` 之後輸出。
  - `④ 算圖`：算圖成功之後輸出，當作最後的回覆。
- 進度行的格式是「`① 腳本｜`產出了什麼 → 一句為什麼」，下面各步有範例。
- 所有給使用者看的文字都用使用者下指令的語言，**包括工具呼叫之間的短句**；中文指令就全程用繁體中文，從第一句開始就不要夾英文。

### ① 讀素材，寫腳本

依素材種類讀內容：

| 素材 | 怎麼讀 |
|---|---|
| 目前所在的 repo 或本機路徑 | README、`package.json`、主要頁面與 API 的檔案，找出「這是什麼、給誰用、三個亮點」 |
| GitHub 網址 | `gh repo view <owner/repo>` 與 README；沒有 gh 就用網頁抓取 |
| 網站網址 | 網頁抓取讀文字，再截圖（見下方「網站截圖」）；抓到的只有「載入中」或空白（前端算畫面的網站）時，以截圖和錨點檔為準 |
| PDF、文章、一段文字 | 直接讀，整理成重點 |

**網站截圖**：預設截手機版整頁長圖，給手機鏡頭在手機框裡捲動。挑 3–5 頁最能代表網站的頁面（首頁、每個主要作品或功能頁、文章、關於或聯絡），每頁用 `--name` 取不同檔名。網站只有一頁（單頁應用、功能都在首頁）時，截首頁一張就夠，之後每一句用同一張長圖捲到不同段落：

```bash
node <skill>/scripts/capture.mjs <網址> --out <out> --mobile --full --shots 0 --name home
node <skill>/scripts/capture.mjs <網址>/projects/x --out <out> --mobile --full --shots 0 --name project
```

每張長圖旁邊會一起產生錨點檔（`home-full.json`），列出頁面上每個標題與大字的位置。**截完先讀錨點檔**：分鏡表用 `to` 寫「手機捲到哪段字」，字必須是錨點檔裡有的。網站可能有深色模式時（`<meta name="color-scheme">` 不可靠，一律截圖比對），首頁再加 `--scheme dark --name home-dark` 截一張，看圖跟淺色版比對：真的變成深色才給「狀態切換」鏡頭用，看起來一樣就不排這一幕。多截的頁面沒用到也沒關係，留著就好。需要桌面版畫面時（`browser` 幕）改用 `--shots 2`、不加 `--mobile`。

`<out>` 裡已經有截圖（`shot-*.png` 或其他 `.png`、`.jpg`）時直接沿用，不要重新截圖。例外：要做 9:16 但現有截圖是橫的（寬大於高），放進直式畫面會很小，先告訴使用者，再用 `--mobile` 另外截一組（使用者可能先備好畫面，避開網路不穩或線上資料空白）。截圖後先看圖；畫面上的數字是 `--`、空白或載入中時，告訴使用者，不要把那一塊當成推近重點。

腳本一定要寫成檔案 `<out>/script.md`：一句一行、前面編號，一句對應一幕。之後排分鏡照這份檔案走，使用者想改文案時改這份就好。

**使用者已經備好腳本時，直接沿用，不要改寫。** 符合下面任一種就算備好了：

- `<out>/script.md` 已經存在。
- 使用者在指令裡給了一個腳本檔（一句一行、或有編號的條列），或說「用這份腳本」。

沿用時，把內容原樣寫進 `<out>/script.md`（已經在那裡就不用動）。素材仍然要讀，用來截圖、找畫面，但不改腳本的字；有句子超過 20 字或寫了素材裡讀不到的事，在進度行後面提醒使用者，由他決定要不要改。

**沒有備好腳本時**，從素材寫 6–10 句短句（一句就是一個 1–2 秒的鏡頭）。原則：

- 第一句是「看的人得到什麼」，不是產品名稱；影片上會分兩行顯示（例如「把想法／做成真的。」）。`script.md` 裡一句一行、不寫換行符號，換行只在 ③ 分鏡的 `heading` 裡用 `\n` 加。
- 每句 12 字以內（最多 20 字），影片上要能一眼讀完；名字、作品名、功能名可以單獨成一句。
- 作品、功能、方案這類清單，**每一項各一句**（之後各給一張作品卡），不要合成一句。
- 本 repo 的範例（`examples/`）只用來看結構和排法，腳本要照你讀到的素材寫；素材剛好是範例的同一個網站時也不要照抄。
- 每一句都要有畫面能證明它：說到某一頁的內容，那一頁就要截圖；說到狀態切換（深色／淺色、修改前後），兩個狀態都要截圖。
- 只寫素材裡讀得到的事實，不要編數字或功能。

`script.md` 寫好（或確認沿用）之後輸出進度行，把腳本逐句列出來：

```text
① 腳本｜docs/demo/script.md，6 句 → 只寫 README 和程式裡讀得到的事實
  1. 台灣天氣，一頁看完
  2. 選縣市，看現在天氣與日出日落
  …
```

沿用時改成 `① 腳本｜docs/demo/script.md，6 句 → 沿用你備好的腳本，一字不改`。

### ② 挑風格與設定

這一步決定四件事：**風格、比例（16:9 橫式／9:16 直式）、總秒數、幕數**。使用者已經在指令裡指定的項目就不再問；四項都指定了就跳過提問，直接輸出進度行。

**有 `mcp__make-demo-video__show_options` 工具時**（make-demo-video 面板已載入），用面板問：

1. 呼叫它，傳 `out`（輸出資料夾）、`suggested`（依素材推薦的三個內建風格 id，最合適的放第一個）、`scenes`（腳本句數）、`seconds`（建議總秒數）。
2. 輸出進度行 `② 風格｜請在右側面板選擇風格、比例、秒數與幕數`，然後**結束這一回合**，不要再呼叫工具。
3. 使用者按「確定」後，下一則訊息會是 `② 選好了：風格 …、比例 …、約 … 秒、… 幕`，照它繼續。

**沒有這個工具時**，用 AskUserQuestion 一次問四題（同一次呼叫）：

| 題目 | 形式 |
|---|---|
| 風格 | 選項題：依素材挑最合適的三個內建風格，第四個固定是「從素材定義風格」；每個選項的 `preview` 放色票與氣氛（例如 `底 #faf9f4・字 #1c1c1c・重點 #ffe14d｜劇本紙、螢光筆`） |
| 比例 | 選項題：「16:9 橫式（README、簡報）」「9:16 直式（社群短影音）」 |
| 秒數 | 數字題 `kind: "number"`，`min: 10`、`max: 60`、`step: 5`、`unit: "秒"`，預設 15（README 動圖 12–20 秒最剛好） |
| 幕數 | 數字題 `kind: "number"`，`min: 3`、`max: 12`、`unit: "幕"`，預設為腳本句數 |

這個版本的 AskUserQuestion 不支援數字題時，秒數改成選項題（12／20／30／45 秒），幕數改成選項題（腳本句數、少一幕、多一幕）。

**從素材定義風格**：從素材裡取色與氣氛（網站的主色與字體、品牌色、使用者提供的圖片或描述），照「風格檔格式」寫一份 `<out>/style.json`，告訴使用者取了哪幾個顏色、從哪裡取的。文字與底色的對比要夠（深底配淺字或反過來），`accentText` 要能在 `accent` 色塊上讀得清楚；`accentInk` 是重點色當「字」用時的顏色：快節奏風格的重點字都是大標題，直接用品牌色本身就好（大字對比 2.5 以上就看得清楚）；只有品牌色在底色上幾乎看不見（例如淺黃配白底）時，才換成較深的同色系。要做出快節奏的質感，自訂風格從這份範本改顏色與字體（欄位說明見「風格檔格式」）：

```json
{
  "id": "site-name", "name": "網站名稱", "description": "取自哪裡、什麼氣氛",
  "colors": { "bg": "淺色底", "surface": "卡片色", "text": "近黑字", "muted": "灰字", "accent": "品牌色",
              "accentText": "品牌色色塊上的字", "accentInk": "通常同 accent", "border": "線條色", "invertBg": "深色模式的底" },
  "fonts": { "display": "\"網站字體\", \"PingFang TC\", sans-serif", "body": "\"網站字體\", \"PingFang TC\", sans-serif", "mono": "Menlo, \"PingFang TC\", monospace" },
  "fontUrl": "（網站用 Google Fonts 時）",
  "radius": 22, "shadow": "0 12px 32px rgb(0 0 0 / 0.10)",
  "motion": { "enter": "rise", "heading": "blur", "duration": 0.4, "transition": "cut" },
  "decor": "halo", "mark": "ink", "align": "left", "progress": false, "caption": "plain"
}
```

幾個欄位的意思：

- `motion`：`{ "enter": "rise", "heading": "blur", "duration": 0.4, "transition": "cut" }`，標題 0.16 秒內由模糊彈成清楚、之後不動；幕與幕之間直接切，特別的轉場寫在分鏡表的各幕。
- `decor: "halo"`（格線＋會動的重點色光暈）、`mark: "ink"`（重點字只換顏色）、`align: "left"`（大標題靠左）、`progress: false`。
- 網站有深色模式時，`invertBg` 取深色模式的底色；沒有深色模式就不寫（會用 `text` 的近黑色）。
- 網站用系統字體時，`fonts` 寫 `"system-ui, -apple-system, \"PingFang TC\", \"Noto Sans TC\", sans-serif"`、不寫 `fontUrl`。
- 網站用 Google Fonts（例如 `next/font/google` 的 `Noto_Sans_TC`、或 `<link href="https://fonts.googleapis.com/...">`）時，`fontUrl` 填同一套字的 Google Fonts CSS 網址（含 700、900 字重），`fonts` 第一個寫那個字體名稱。

選定後輸出進度行，例如 `② 風格｜studio 暖白解說・16:9・30 秒・6 幕 → 產品介紹給一般大眾看`，或 `② 風格｜docs/demo/style.json・9:16・15 秒・4 幕 → 取自網站的米灰底與亮橘重點`。

### ③ 排分鏡

**動手寫 `storyboard.json` 之前先檢查**：`<out>/script.md` 寫好了嗎？這次對話裡已經輸出過 `① 腳本｜…`（含逐句腳本）和 `② 風格｜…` 兩行了嗎？還沒有的話，現在先補，再寫分鏡表。

分鏡由**鏡頭模板**組成：每一句腳本挑一個模板（下表）、填上字和截圖。模板已經包好底色、文字效果、轉場、手機怎麼捲，不要自己用低階參數拼。照下面三步做：

**1. 先在回覆裡列鏡頭表**（給使用者看，也是排分鏡的依據）：

```text
| # | 腳本 | 鏡頭 | 畫面證據（截圖：錨點） | 拍 |
|---|---|---|---|---|
| 1 | 把想法做成真的。 | hook | — | 3 |
| 2 | 洪睦筌 | intro | home-dark-full.png：先停在「把想法」，捲到「做過一些有意思的事」 | 5 |
| 3 | 曉行 Dawnline | card | — | 3 |
| 4 | 切換深色／淺色模式 | toggle | home-dark-full.png → home-full.png | 4 |
| 5 | 出發前，判讀路線風險 | feature | project-full.png：捲到「技術」 | 5 |
```

- **畫面證據**：手機鏡頭（intro、feature、content、cta）一定要寫截圖和錨點，錨點是錨點檔裡講這句話的那段字；找不到能證明這句話的畫面時，換一句、補截圖，或改用 card。
- **相鄰兩幕要不一樣**：同一個模板不連用 3 次；相鄰兩個手機鏡頭不要用同一張截圖捲到同一段（單頁網站用同一張長圖沒關係，捲到不同段落就好；兩段太近時換 `layout`）。
- **拍數**：`beat` 預設 0.4 秒一拍，各模板的預設拍數見下表。總拍數 × 0.4 ≈ ② 選的秒數（差 3 秒以內，寧短勿長）；幕數等於 ② 選的幕數，和句數不同時先改 `script.md` 並告訴使用者改了哪幾句。預設拍數加起來太長時，先從 intro、feature、content 減（最少 3 拍）；hook、card 不要少於 3 拍，outro 不要少於 4 拍（結尾要讓人看清楚網址）。

| 鏡頭 | 用在 | 必填 | 選填 | 預設拍 | 模板自動做的事 |
|---|---|---|---|---|---|
| `hook` | 第一句、標語 | heading | kicker | 3 | 滿版重點色；兩行字一行一行彈出 |
| `intro` | 名字、產品名第一次出現 | heading、image | kicker、to、from | 5 | 深色底；手機從下方升起，從上一句出現的位置慢慢開始捲（跨鏡頭銜接；截圖上找不到上一句就從頁首開始），後半捲到 `to` |
| `card` | 作品、方案這類清單的每一項（沒有畫面也講得清楚的） | heading | label、icon、year（沒有年份就不寫）、kicker、align（`center` 時卡片與字整組置中） | 3 | 手機後面接時往鏡頭衝（zoom）、卡接卡閃白（flash）；底色深色、橘色輪流；標題保證停得夠久 |
| `toggle` | 狀態切換（深色／淺色、修改前後） | heading、image、after | pill、to | 4 | 前 40% 是 image（深色底），斜切成 after（淺色底），字不重新進場 |
| `feature` | 一個作品或功能的細節 | heading、image | kicker、tags、to | 5 | 前一幕糊掉、手機從右邊滑入，標籤一個個彈出，捲到 `to` |
| `content` | 文章、說明、內容列表 | heading、image | to | 4 | 深色底、手機在另一側，捲到 `to` |
| `cta` | 號召行動（聯絡、試用、下載）；單頁網站沒有號召行動時，給最後一個功能當特寫 | heading、image | to | 3 | 手機特寫（放大、下緣出畫面），很快捲到 `to` 停住 |
| `outro` | 最後一句 | heading | kicker、sub、url | 5 | 從畫面上一點展開成重點色，名字彈進來，網址膠囊（沒寫 url 時用分鏡表最上層的 url）；不放 QR code |

- **只有一張長圖時**（單頁網站）：每一句都用手機鏡頭、捲到截圖上講這件事的那段（`to` 寫那段的標題或標籤），模板之間輪流換（intro → feature → content → cta），不要為了避開同一張圖而把功能改成作品卡。作品卡只給「真的是一項一項的清單」用。
- 錨點只收標題、大字、粗體短標籤和輸入框提示文字，不收純數字（氣溫、價格會變）。要的字不在錨點檔裡時，改用旁邊的區塊標題當 `to`。
- `heading` 放腳本原句，可以加 `\n` 分兩行、`**粗體**` 換成重點色，不改字。`kicker` 是標題上方的小字，`tags` 是 3–6 個 1–3 字的關鍵字，`pill` 是膠囊標籤。
- `to`、`from` 寫錨點檔裡的字（部分符合就行），`from` 只在想指定手機從哪裡開始時才寫。
- 需要時可以覆寫：`beats`、`tone`（base、invert、accent）、`transition`、`layout`、`textFx`（blur、rise）。沒有特別理由就用模板預設；自動檢查提醒「太像」時才換 `layout`。`layout` 三種：`right` 字在一側、手機在另一側（直式是字在上、手機在下）；`left` 左右對調（直式是手機在上、字在下）；`big` 手機放大、下緣出畫面的特寫，字壓在上方。
- 素材不是網站（CLI、程式碼、純文字）時，可以混用舊的低階幕別（見「分鏡表格式」最後），但能用模板的句子就用模板。

**2. 寫 `<out>/storyboard.json`**：照鏡頭表寫（格式見下）。

**3. 跑自動檢查，修到沒有提醒**：

```bash
node <skill>/scripts/check.mjs --storyboard <out>/storyboard.json
```

它會檢查：錨點找不到（錯誤，會列出截圖裡有的字）、標題出完停不到 0.5 秒、相鄰兩幕太像、手機畫面沒對上這句話、單幕太長、同一種底色連太多幕、平均鏡頭太慢。有錯誤或提醒就改分鏡表再跑，直到「自動檢查沒有提醒」。真的改不掉的提醒（例如使用者指定的秒數讓平均變慢），在 ③ 進度行後面說明原因。

檢查通過後輸出進度行，例如 `③ 分鏡｜docs/demo/storyboard.json，9 幕 12 秒 → 開場標語、介紹、兩張作品卡、深淺切換、功能、文章、號召、結尾；自動檢查沒有提醒`。

**② 是用面板問的時候**（呼叫 `show_options` 成功），輸出 ③ 進度行後就**結束這一回合**：面板會自己產生每一幕的縮圖（分鏡板），讓使用者確認、調整，按「合成影片」後才進 ④。不要自己跑 `frames.mjs` 或 `render.mjs`。

**沒有面板時**，直接進 ④。

### ④ 算圖輸出

```bash
node <skill>/scripts/render.mjs --storyboard <out>/storyboard.json --style <風格 id 或 style.json 的路徑> --out <out>
```

預設每秒 30 格。GIF 預設橫式 640 寬、直式 360 寬、每秒 12 格；超過 5 MB 時 render.mjs 會提醒，照它給的參數重跑就好。完成後會印出 MP4、GIF、結果頁的路徑，並在 macOS 上自動打開結果頁。算圖成功就直接回報，不要再抽格、截圖或讀影片檢查（render.mjs 已經驗過分鏡表，使用者正在看結果頁）。最後的回覆保持短，前三步已經講過的不要重複：

```text
④ 算圖｜docs/demo/demo.mp4、demo.gif，13.6 秒 → 結果頁已打開（加了 --no-open 時改寫結果頁的路徑）
README：[![demo](docs/demo/demo.gif)](<網址>)
想改就說，例如「第三幕字幕改短」「換成霓虹風格」，改完重跑同一行指令即可。
```

算圖失敗時，錯誤訊息會指出哪一幕的哪個欄位有問題，修正分鏡表後重跑；不要改 `player/` 或 `scripts/` 來繞過檢查。

### 面板送來的訊息

使用者在面板上按的按鈕，會變成一則以固定字樣開頭的訊息。面板上的上移、下移、刪除、改字，以及「重新選」只換風格，都已經直接改好檔案或設定，不會送訊息。

| 訊息開頭 | 怎麼做 | 做完 |
|---|---|---|
| `合成影片：…用風格 X 算圖`（舊版是 `重新算圖：`） | 分鏡板已經是使用者要的樣子：**不要改 `storyboard.json` 或 `script.md`**，用訊息裡的風格 X 跑 ④ 的算圖指令（使用者可能在面板上換過風格，以訊息為準） | 輸出 `④ 算圖｜…` |
| `② 改選：…（原本 …）` | 使用者改了比例、秒數或幕數：照 ③「照 ② 的選擇排」重排 `storyboard.json`（9:16 要手機截圖、秒數與幕數對準、句數不同時調整 `script.md` 並告知）；句子沒變的幕盡量沿用原本的畫面 | 輸出 `② 風格｜…`、`③ 分鏡｜…`，結束這一回合 |
| `照腳本重排：` | `script.md` 是使用者要的腳本，**不改它的字**。照 ③ 的規則一句一幕重寫 `storyboard.json`：句子沒變的幕沿用原本的畫面、推近與點擊，新的句子補上合適的畫面；比例、風格不變，總秒數維持 ② 選的長度 | 輸出 `③ 分鏡｜…`，結束這一回合 |
| `插入一幕：在第 N 幕後面插入一句「…」` | 在第 N 幕後面插一幕給這句：挑合適的鏡頭模板與截圖，`heading` 用這句原文；**其他幕的畫面與字幕不動**，必要時微調其他幕秒數讓總長維持 ② 選的長度。訊息註明「script.md 已更新」就不要再改腳本，沒註明就把這句插進 `script.md` 同一個位置 | 輸出 `③ 分鏡｜…`，結束這一回合 |
| `重畫第 N 幕：…` | 照冒號後的要求只改第 N 幕的畫面（`shot`、`image`、`to`、拍數等），`heading` 維持腳本原句；**其他幕不動**。要求是「換一個呈現方式」時，換一種鏡頭模板或換一頁截圖。改完跑 `check.mjs` | 輸出 `③ 分鏡｜…`，結束這一回合 |

改完分鏡表就停下來，面板會重算縮圖，等使用者再按「合成影片」。

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
  "aspect": "9:16",
  "url": "https://example.com",
  "beat": 0.4,
  "scenes": [
    { "shot": "hook", "heading": "**看的人得到什麼**\n一句話。" },
    { "shot": "intro", "kicker": "小標", "heading": "產品或人名", "image": "home-dark-full.png", "to": "首頁上第二段的標題" },
    { "shot": "card", "label": "01 / AI", "icon": "◈", "year": "2026", "kicker": "01 / AI・2026", "heading": "作品一" },
    { "shot": "card", "label": "02 / WEB", "icon": "✚", "year": "2026", "kicker": "02 / WEB・2026", "heading": "作品二" },
    { "shot": "toggle", "pill": "☾ 深色 ／ 淺色 ☀", "heading": "切換前後的那一句", "image": "home-dark-full.png", "after": "home-full.png" },
    { "shot": "feature", "kicker": "作品一", "heading": "這個作品\n**做了什麼**", "tags": ["技術", "技術", "技術"], "image": "project-full.png", "to": "作品頁上的某段標題" },
    { "shot": "content", "heading": "內容頁的\n**那一句**", "image": "articles-full.png", "to": "文章頁上的某個標題" },
    { "shot": "cta", "heading": "號召行動\n**那一句**", "image": "home-full.png", "to": "聯絡區的標題" },
    { "shot": "outro", "kicker": "小標", "heading": "名字或產品名", "sub": "一行說明" }
  ]
}
```

`<skill>/../../examples/muchuan-reference/` 如果存在（只在開發者本機，不隨 plugin 發佈），裡面是一份完整的標準答案（9:16、對照參考影片）：第一次排分鏡前先讀它的 `shots.md`（每一幕為什麼這樣排）與 `storyboard.json`。

- `aspect`：`16:9`（預設）、`9:16`（直式短影音）、`1:1`。`beat`：一拍幾秒，預設 0.4。
- 每一幕寫 `shot` 與模板要的欄位（見 ③ 的表）；`beats` 或 `seconds` 不寫就用模板預設。
- `image`、`after` 的路徑相對於分鏡表所在的資料夾，用 capture.mjs 產生的檔名（`.png`；範例轉成 `.jpg` 只是為了讓 repo 小一點）；旁邊同名的 `.json` 是錨點檔。

**舊的低階幕別**（素材不是網站時用；不寫 `shot`、改寫 `kind` 與 `seconds`）：

```json
{ "kind": "browser", "seconds": 4, "address": "example.com", "image": "shot-1.png",
  "focus": [{ "at": 0, "x": 0.5, "y": 0.5, "zoom": 1 }, { "at": 0.6, "x": 0.3, "y": 0.4, "zoom": 1.6 }],
  "clicks": [{ "at": 0.4, "x": 0.3, "y": 0.4 }], "caption": "字幕" }
{ "kind": "terminal", "seconds": 4, "name": "Claude Code", "lines": ["會逐字打出來的指令", { "type": "out", "text": "輸出", "highlight": true }] }
{ "kind": "file", "seconds": 3, "name": "style.md", "lines": ["一行", { "text": "要標亮的一行", "highlight": true }] }
{ "kind": "points", "seconds": 3, "heading": "三個重點", "items": ["一", "二", "三"] }
{ "kind": "title" | "outro" | "phone" | "card", ... }
```

- 低階幕別都可以加 `caption`（字幕）、`step`（上方標籤）、`tone`、`transition`（`cut`、`fade`、`slide`、`blur`、`wipe`、`push`、`zoom`、`flash`、`iris`）。
- `focus`、`clicks` 的 `at` 是這一幕的進度（0–1），`x`、`y` 是圖片上的位置比例。

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
  "motion": { "enter": "rise | pop | step | blur", "heading": "（選填）標題的進場，同 enter", "duration": 0.4,
              "transition": "fade | cut | slide | blur | wipe | push | zoom | flash | iris" },
  "decor": "none | paper | scanlines | grid | glow | halo",
  "caption": "plain | bar | highlight",
  "mark": "box | ink（選填，重點字畫色塊或只換字色，預設 box）",
  "align": "center | left（選填，title／outro 的版面，預設 center）",
  "progress": "true | false（選填，底部進度條，預設 true）",
  "fontUrl": "（選填）Google Fonts 的 CSS 網址，算圖時會先下載"
}
```

`colors` 也可以加 `invertBg`：`tone: "invert"` 幕的底色，沒寫時用 `text`。

字體清單一定要以中文字體收尾（例如 `"PingFang TC", "Noto Sans TC", sans-serif`），否則中文會退回系統預設字體。
