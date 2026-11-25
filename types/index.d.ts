// make-demo-video 面板的狀態合約：一次 /make-demo-video 的進度與使用者在面板上的選擇。

export type Aspect = '16:9' | '9:16'

/** 使用者在 ② 選的設定；style 是內建風格 id，或 "custom"（從素材定義風格）。 */
export type Choice = { style: string; aspect: Aspect; seconds: number; scenes: number }

/** 分鏡表裡的一幕，面板只需要這幾個欄位。kind 是鏡頭模板的中文名稱（用模板時）或幕別。 */
export type SceneRow = { kind: string; seconds: number; label: string }

/** 分鏡自動檢查的提醒（frames.mjs 寫的 frames/lint.json）；row 是第幾幕（0 起算），null 是整支影片。 */
export type LintNote = { row: number | null; message: string }

export type Run = {
  /** 這次是否在跑 /make-demo-video；沒在跑時面板只顯示提示。 */
  isActive: boolean
  /** 開始的時間（毫秒）；比它舊的 storyboard.json、demo.mp4 不算這次的產出。 */
  startedAt: number
  /** 輸出資料夾（相對於工作目錄或絕對路徑），從 Claude 的工具呼叫裡認出來。 */
  out: string | null
  script: string[]
  /** Claude 呼叫了 show_options，正在等使用者在面板上選。 */
  isPicking: boolean
  /** Claude 建議的風格 id，面板上會標「推薦」。 */
  suggested: string[]
  choice: Choice
  isChosen: boolean
  scenes: SceneRow[]
  /** 分鏡表在上次合成影片之後改過（或還沒合成過），要按「合成影片」。 */
  isEdited: boolean
  /** 腳本在面板上被改過，分鏡表還沒照新腳本重排。 */
  isScriptEdited: boolean
  renderedAt: number | null
  renderSeconds: number | null
  /** 讀檔失敗等狀況的說明，面板最下方用淡色顯示，方便排查。 */
  note: string | null
  /** 分鏡縮圖（frames/scene-N.png）最後產生的時間；也當作圖片的 generation，換圖時畫面才會更新。 */
  framesAt: number | null
  /** 正在產生分鏡縮圖。 */
  isFraming: boolean
  /** 分鏡自動檢查的提醒，顯示在對應的分鏡卡上。 */
  lint: LintNote[]
  /** 分鏡卡下方打開的輸入框：在第 index 幕後插一句、重畫第 index 幕，或改第 index 句的字。 */
  openInput: { kind: 'insert' | 'redo' | 'edit'; index: number } | null
  /** 按「重新選」時的原設定；確定後拿來比對改了哪些項目。 */
  pickedFrom: Choice | null
}

declare module 'claude-code' {
  interface PluginState {
    'make-demo-video': { run: Shaped<Run> }
  }
}
