# make-demo-video

繁體中文 | [English](/README.en.md)

Claude Code 的 skill 加 mod，把 repo、網址、PDF 或一段文字，幾分鐘內做成一支 demo 影片（MP4＋GIF，可以直接放進 README）：

- **Skill**：`/make-demo-video` 讀素材、寫腳本、排分鏡，再用瀏覽器逐格算圖、ffmpeg 合成。
- **Mod**：對話旁邊的進度面板。在面板上選風格、看每一幕的縮圖、調整分鏡，確認後按「合成影片」。

![在 VS Code 跑一次 /make-demo-video：寫腳本、在面板選風格、調整分鏡板、合成影片](examples/skill-flow/skill-flow.gif)

這支示範片是用 HTML 重建的示意動畫，不是實機錄影：等待的時間壓短了（實機寫腳本約 1 分鐘、算圖約 20 秒），聊天面板也畫得比實機簡單。畫面裡的分鏡縮圖與結果頁播的影片，是真的用這個工具算出來的。原始檔在 [`examples/skill-flow/`](examples/skill-flow/)。

### 怎麼運作

| 步驟 | 做什麼 | 產出 |
|---|---|---|
| ① 腳本 | Claude 讀素材，一句一幕寫出腳本 | `script.md` |
| ② 風格 | 在面板選內建風格、比例、秒數、幕數，或從素材取色 | `style.json`（自訂時） |
| ③ 分鏡 | 分鏡板上移、刪除、改字、重畫某一幕 | `storyboard.json` |
| ④ 合成 | 確認後算圖 | `demo.mp4`、`demo.gif`、結果頁 |

影片是「分鏡表＋風格」算出來的，不是錄螢幕：改一句字幕或換一個風格，大約 20 秒重算一次；分鏡表是純文字，可以 commit、code review。

### 安裝

```bash
claude plugin marketplace add muchuanhung/make-demo-video
claude plugin install make-demo-video@make-demo-video --scope user
```

安裝後新開的 session 才會載入。需要 Node 18 以上與 Google Chrome；ffmpeg 已附在套件裡。

### 使用

```text
/make-demo-video 把這個 repo 做成 README 用的 demo 影片
/make-demo-video https://example.com 做一支 20 秒的直式介紹影片
```

面板在 VS Code 的 Claude 聊天面板，以及支援 kitty graphics 的終端機（Ghostty、kitty）顯示縮圖；沒有面板的環境（例如 `claude -p`）會改用對話框問同樣的問題。

### 實測過

只在 macOS 上實測過，不保證其他平台或之後的 Claude Code 版本。

- VS Code 的 Claude 聊天面板（Claude Code 2.1.331）：從網址做一支 9:16、9 幕的影片，① 到 ④ 全程用面板操作。
- `claude -p`：選項、重畫一幕、插入一幕都照預期產出。
- 素材：weather-board、發發菜單、Kinutabi、Syntax Atlas、muchuan-portfolio；16:9 與 9:16 都算過。
- 沒測過：終端機裡的面板畫面、Linux、Windows。

### 檢查

```bash
claude plugin validate .
claude plugin test .
node skills/make-demo-video/scripts/thumbs.mjs --check
```

### 授權

MIT，見 [LICENSE](/LICENSE)。
