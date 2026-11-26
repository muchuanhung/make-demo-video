// make-demo-video 面板的狀態合約：一次 /make-demo-video 的進度與使用者在面板上的選擇。

export type Aspect = '16:9' | '9:16'

/** 使用者在 ① 選的設定；cut 是剪法 id（cuts/<id>/），style 是內建風格 id，或 "custom"（從素材定義風格）。 */
export type Choice = { cut: string; style: string; aspect: Aspect; seconds: number; scenes: number }

/**
 * 分鏡表裡的一幕，面板只需要這幾個欄位。kind 是鏡頭模板的中文名稱（用模板時）或幕別。
 * beats：用鏡頭模板、沒寫死 seconds 時的拍數（面板的 − ＋ 一次改一拍）；其他情況是 null，− ＋ 改 seconds。
 */
/** fixedText：卡上的字是鏡頭對準的網頁上的字（操作示範），不能在面板改字 */
export type SceneRow = { kind: string; seconds: number; label: string; beats?: number | null; fixedText?: boolean }

/** 分鏡自動檢查的提醒（frames.mjs 寫的 frames/lint.json）；row 是第幾幕（0 起算），null 是整支影片。 */
export type LintNote = { row: number | null; message: string }

/** 生成式剪法（招牌片）的一拍：signature.mjs beats 寫的 beats/beats.json。file 是原尺寸 PNG，thumb 是給 VS Code 面板的小 JPEG。 */
export type BeatRow = { beat: number; at: number; file: string; thumb?: string }

export type Run = {
  /** 這次是否在跑 /make-demo-video；沒在跑時面板只顯示提示。 */
  isActive: boolean
  /** 開始的時間（毫秒）；比它舊的 storyboard.json、demo.mp4 不算這次的產出。 */
  startedAt: number
  /** 輸出資料夾（相對於工作目錄或絕對路徑），從 Claude 的工具呼叫裡認出來。 */
  out: string | null
  script: string[]
  /** Claude 呼叫了 show_options，正在等使用者在面板上選剪法與設定。 */
  isPicking: boolean
  /** Claude 依素材推薦的剪法 id，第一個是預設選取，面板上會標「推薦」。 */
  suggested: string[]
  /** Claude 推薦第一個剪法的理由（要寫到這次的素材），顯示在剪法卡下方。 */
  reason: string | null
  choice: Choice
  isChosen: boolean
  scenes: SceneRow[]
  /** 分鏡表在上次合成影片之後改過（或還沒合成過），要按「合成影片」。 */
  isEdited: boolean
  /** 腳本在面板上被改過，分鏡表還沒照新腳本重排。 */
  isScriptEdited: boolean
  renderedAt: number | null
  renderSeconds: number | null
  /** ④ 的「加配樂」開關：按「合成影片」時請 Claude 加 --music（招牌片本來就有配樂，不看它）。 */
  music: boolean
  /** 上次算圖有沒有加 --music；跟 music 不同時可以再按「合成影片」補上或拿掉配樂。還沒算過是 null。 */
  renderedMusic: boolean | null
  /** 讀檔失敗等狀況的說明，面板最下方用淡色顯示，方便排查。 */
  note: string | null
  /** 分鏡縮圖（frames/scene-N.png）最後產生的時間；也當作圖片的 generation，換圖時畫面才會更新。 */
  framesAt: number | null
  /** 正在產生分鏡縮圖。 */
  isFraming: boolean
  /** 分鏡自動檢查的提醒，顯示在對應的分鏡卡上。 */
  lint: LintNote[]
  /** 分鏡卡下方打開的輸入框：在第 index 幕後插一句、重畫第 index 幕、改第 index 句的字，或（招牌片）改第 index 拍。 */
  openInput: { kind: 'insert' | 'redo' | 'edit' | 'beat'; index: number } | null
  /** 生成式剪法：Claude 呼叫 show_concepts 給的概念，等使用者在面板上挑一個。 */
  concepts: string[]
  isConceptPicking: boolean
  /** 使用者挑定的概念（或「你來決定」）。 */
  concept: string | null
  /** 生成式剪法的逐拍分鏡板：signature.mjs beats 跑完後讀進來。 */
  beats: BeatRow[]
  /** 逐拍縮圖最後產生的時間；也當作圖片的 generation。 */
  beatsAt: number | null
  /** signature.mjs beats 的自動檢查結果（空的就是通過）。 */
  beatProblems: string[]
  /** 分鏡縮圖產生失敗的原因；下次成功時清掉。 */
  framesNote: string | null
  /** 按「重新選」時的原設定；確定後拿來比對改了哪些項目。 */
  pickedFrom: Choice | null
}

declare module 'claude-code' {
  interface PluginState {
    'make-demo-video': { run: Shaped<Run> }
  }
}
