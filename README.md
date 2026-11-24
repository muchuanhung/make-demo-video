# make-demo-video

一個 Claude Code skill：把 repo、網址、PDF 或一段文字變成一支 demo 影片（MP4＋GIF，可以直接放進 README）。

![五種內建風格](examples/weather-board/reel/reel.gif)

## 安裝

```text
/plugin marketplace add muchuanhung/make-demo-video
/plugin install make-demo-video@make-demo-video
```

需要 Node 18 以上與 Google Chrome。第一次使用時 skill 會自己裝好相依套件，ffmpeg 已附在套件裡。

## 使用

在 Claude Code 裡說：

```text
/make-demo-video 把這個 repo 做成 README 用的 demo 影片
/make-demo-video https://example.com 做一支 20 秒的直式介紹影片
```

## 怎麼運作

跟大多數影音生成工具一樣分四步，每一步都可以單獨改：

| 步驟 | 做什麼 | 產出 |
|---|---|---|
| ① 腳本 | Claude 讀素材，寫出 4–7 句腳本 | 對話裡的腳本 |
| ② 風格 | 挑內建風格，或讓 Claude 從素材取色定義一個 | `style.json`（自訂時） |
| ③ 分鏡 | 一句一幕，決定秒數、畫面、字幕、推近與點擊 | `storyboard.json` |
| ④ 算圖 | 瀏覽器逐格算圖，ffmpeg 合成 | `demo.mp4`、`demo.gif`、結果頁 |

影片是「分鏡表 ＋ 風格」算出來的，不是錄螢幕。所以：

- 改一句字幕或換一個風格，重跑一行指令，大約 20 秒。
- 分鏡表是純文字，可以 commit、diff、code review。
- 每一格都是時間的純函式，同樣的輸入每次算出一樣的影片。

## 內建風格

| id | 名稱 | 適合 |
|---|---|---|
| `screenplay` | 紙卡劇本 | 說故事、活動預告 |
| `studio` | 暖白解說 | 產品介紹、教學 |
| `terminal` | 終端機 | 開發工具、技術分享 |
| `neon` | 霓虹 | 活動、舞台感開場 |
| `blueprint` | 藍圖 | 架構、流程、系統 |

分鏡表與風格檔的格式見 [`skills/make-demo-video/SKILL.md`](skills/make-demo-video/SKILL.md)，範例見 [`examples/weather-board/`](examples/weather-board/)。

## 進度面板（mod）

安裝 plugin 後，跑 `/make-demo-video` 時會在對話旁邊打開一個面板，跟著 ① 腳本 → ② 風格 → ③ 分鏡板 → ④ 合成影片 前進：

- ① 腳本在分鏡板出現前可以逐句上移、下移、刪除、新增。
- ② 用面板選風格（縮圖＋色票）、比例（16:9／9:16）、秒數與幕數。
- ③ 分鏡板：每張卡是一句腳本加上這一幕的縮圖（`scripts/frames.mjs` 每幕截一格，約 1 秒）。上移、下移、刪除直接改檔案；「插一句」「重畫」交給 Claude 只改那一幕。
- ④ 確認分鏡板後按「合成影片」才算整支影片。
- 縮圖在 VS Code 的 Claude 聊天面板與支援 kitty graphics 的終端機（Ghostty、kitty）看得到；其他終端機只顯示色票。
- 沒有面板的環境（例如 `claude -p`）會改用對話框問同樣四件事。

## 開發

新增或修改 `skills/make-demo-video/styles/` 的風格檔後，重算面板用的縮圖：

```bash
cd skills/make-demo-video
node scripts/thumbs.mjs          # 重算縮圖，更新 styles/thumbs/manifest.json
node scripts/thumbs.mjs --check  # 只檢查：有風格缺縮圖或改過沒重算，就列出來並失敗
```

面板（`hooks/register.tsx`）的測試與檢查，在 repo 根目錄跑：

```bash
claude plugin test .
claude plugin validate .
```

## 授權

MIT
