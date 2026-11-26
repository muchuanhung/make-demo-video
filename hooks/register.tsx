// make-demo-video 的四步進度面板：跟著 ① 剪法與設定 → ② 腳本 → ③ 分鏡板 → ④ 合成影片 前進。
// - ① 由 Claude 讀完素材後呼叫 show_options 展開：剪法大卡（縮圖、適合什麼、Claude 的推薦理由）、
//   比例、秒數、幕數，按「確定」把選擇當成下一則訊息送出。外觀一律從素材取色（Claude 寫 style.json），面板不提供內建色票。
//   剪法決定腳本怎麼寫，所以先選剪法再寫腳本。選完可以按「重新選」：
//   改了比例、秒數或幕數請 Claude 重排分鏡；換了剪法請 Claude 照新剪法重寫腳本與分鏡。
// - ② 腳本在分鏡板出現前可以直接改；之後收成一行，改動都在分鏡卡上做。
// - ③ 分鏡板：每張卡是「一句腳本＋這一幕的縮圖」。↑ ↓ ✕ 直接改 storyboard.json 與 script.md；
//   ＋ 插一句、⟳ 重畫這一幕交給 Claude 只改那一幕。分鏡表一變，面板自己跑 frames.mjs 重算縮圖（約 1 秒）。
// - ④ 使用者確認分鏡板後按「合成影片」才算整支影片。
// - 生成式剪法（招牌片，meta.json 的 mode 是 generate）沒有 storyboard.json：③ 先由 Claude 呼叫 show_concepts 讓使用者挑概念，
//   Claude 寫好 reel.html、跑 signature.mjs beats 之後，面板讀 beats/beats.json 畫逐拍分鏡板（一小節一排，每拍可以留意見）。
// - VS Code 等沒有 Image 的畫面，縮圖要包成 base64 SVG；面板輸出上限 256KB，所以用小 JPEG，並且限制縮圖總量。
// 進度從 Claude 的工具呼叫認出來（寫了 script.md、storyboard.json，跑了 check.mjs、render.mjs），不靠 Claude 回報。
// 沿用上一次留下的分鏡表時 Claude 不會寫檔，所以跑 check.mjs 檢查它也算進到 ③。
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Aspect, BeatRow, Choice, LintNote, Run, SceneRow } from '../types'

const PLUGIN = 'make-demo-video'
const PANE = 'make-demo-video'
const TOOL_NAME = 'show_options'
const CONCEPT_TOOL = 'show_concepts'
/** VS Code 面板輸出上限 256KB；縮圖 SVG（base64）全部加起來不超過這個量，超過的改顯示文字。 */
const SVG_BUDGET = 180_000
const SECONDS = [12, 15, 20, 30, 45, 60]
const MIN_SCENES = 3
const MAX_SCENES = 12 // 跟 SKILL.md 的幕數範圍（3–12）一致
const CUSTOM = 'custom'
const DEFAULT_CUT = 'fast-tour'

const FRESH: Run = {
  isActive: false,
  startedAt: 0,
  out: null,
  script: [],
  isPicking: false,
  suggested: [],
  reason: null,
  choice: { cut: DEFAULT_CUT, style: CUSTOM, aspect: '16:9', seconds: 15, scenes: 6 },
  isChosen: false,
  scenes: [],
  isEdited: false,
  isScriptEdited: false,
  renderedAt: null,
  renderSeconds: null,
  note: null,
  framesAt: null,
  isFraming: false,
  lint: [],
  openInput: null,
  pickedFrom: null,
  concepts: [],
  isConceptPicking: false,
  concept: null,
  beats: [],
  beatsAt: null,
  beatProblems: [],
  framesNote: null,
}

// 欄位改了就換 shape，舊版存下的值會被丟掉，不會讀到形狀不對的資料。
const run = atom({ plugin: 'make-demo-video', key: 'run' } as const, FRESH, { shape: 'run-9' })

/** thumb：PNG 縮圖路徑（終端機用 Image 畫）；svg：VS Code、桌面版等畫面用的縮圖（它們沒有 Image，但有 Svg）。 */
type Thumb = { thumb: string | null; svg: string | null }
/** 內建風格只用來顯示名稱：使用者在對話裡要求換成某個內建風格時，Claude 用它算圖，面板跟著顯示。 */
type StyleInfo = { id: string; name: string }
/** 剪法包 cuts/<id>/meta.json 裡面板要用的欄位；defaults 是剪法建議的比例與秒數。 */
type CutInfo = Thumb & { id: string; name: string; suits: string; mode: string; defaults: { aspect?: Aspect; seconds?: number } }

/**
 * 風格縮圖的 SVG：只是把 PNG 縮圖包起來，PNG（scripts/thumbs.mjs 產生）是唯一的來源，
 * 不另外維護一份向量版面。沒有 PNG 時回傳 null，面板只畫色票。
 */
function thumbSvg(pngBase64: string | null): string | null {
  if (!pngBase64) return null
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" width="160" height="90">' +
    `<image href="data:image/png;base64,${pngBase64}" width="160" height="90"/>` +
    '</svg>'
  )
}
let styles: StyleInfo[] = []
let cuts: CutInfo[] = []
/** session 的工作目錄（終端機的 Image 要絕對路徑）；session.start 時記下。 */
let cwd = ''
/** 分鏡、逐拍縮圖包成的 SVG，以「檔案路徑＃產生時間」為鍵，縮圖重算後自然換成新的。 */
const imageSvgs = new Map<string, string>()

type $Like = EngineInterface

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)))
const nearestSeconds = (n: number) => SECONDS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best))
const join = (dir: string, name: string) => (dir === '' || dir === '.' ? name : `${dir.replace(/\/+$/, '')}/${name}`)
/** 去掉路徑裡的 .、..、重複的 /。 */
function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return (path.startsWith('/') ? '/' : '') + parts.join('/')
}
/**
 * 轉成絕對路徑。base 是 Claude 下指令當時的工作目錄：shell 的 cd 會留到下一個指令（session 的工作目錄跟著變），
 * 輸出資料夾若存成相對路徑，之後讀檔、跑 frames.mjs 會被解析到別的資料夾。
 */
const resolveIn = (base: string, path: string) => normalize(path.startsWith('/') || !base ? path : join(base, path))

/**
 * 面板工具（show_options、show_concepts）收到的 out：Claude 寫的相對路徑是相對於專案根目錄，不是 shell 現在的目錄。
 * Claude 中途 cd 進剪法資料夾讀 cut.md（cd 會留著）之後再呼叫工具，照 shell 目錄解析會變成剪法資料夾底下，
 * 之後的分鏡板、結果頁都讀不到。先試專案根目錄、再試 shell 目錄，取存在的那個；都不存在就用專案根目錄。
 */
async function outDir($: $Like, path: string): Promise<string> {
  if (path.startsWith('/')) return normalize(path)
  const root = await $.session.root().catch(() => cwd)
  const here = await $.session.cwd().catch(() => root)
  const tries = [...new Set([resolveIn(root, path), resolveIn(here, path)])]
  for (const dir of tries) if (await $.fs.exists(dir).catch(() => false)) return dir
  return tries[0] as string
}
const plain = (text: unknown) => String(text ?? '').replace(/\*\*/g, '')

/** script.md 一句一行，去掉編號、條列符號與標題。 */
function parseScript(text: string): string[] {
  return text
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .map(line => line.replace(/^\s*(?:\d+\s*[.、)）]|[-*•])\s*/, '').trim())
    .filter(Boolean)
}

/** 鏡頭模板的中文名稱與預設拍數（跟 skills/make-demo-video/scripts/shots.mjs 的 SHOTS 一致）。 */
const SHOTS: Record<string, { label: string; beats: number }> = {
  hook: { label: '開場標語', beats: 3 },
  intro: { label: '介紹', beats: 5 },
  card: { label: '作品卡', beats: 3 },
  toggle: { label: '狀態切換', beats: 4 },
  feature: { label: '功能標註', beats: 5 },
  content: { label: '內容頁', beats: 4 },
  cta: { label: '號召行動', beats: 3 },
  outro: { label: '結尾', beats: 5 },
  stat: { label: '數字', beats: 4 },
  // 操作示範（walkthrough.mjs）
  reveal: { label: '結果先上', beats: 2 },
  home: { label: '現場', beats: 6 },
  seek: { label: '找', beats: 4 },
  burst: { label: '重拍', beats: 3 },
  click: { label: '點', beats: 5 },
  expand: { label: '展開', beats: 5 },
  focus: { label: '細節', beats: 6 },
  dock: { label: '收尾', beats: 12 },
}

function toRows(board: { scenes?: unknown; beat?: unknown }): SceneRow[] {
  const scenes = Array.isArray(board.scenes) ? board.scenes : []
  const beat = Number(board.beat) || 0.4
  return scenes.map(raw => {
    const s = (raw ?? {}) as Record<string, unknown>
    const items = Array.isArray(s.items) ? s.items.map(plain).join('、') : ''
    const shot = typeof s.shot === 'string' ? s.shot : null
    // 用模板時秒數多半沒寫，照拍數換算
    const beats = shot && !Number(s.seconds) ? Number(s.beats) || SHOTS[shot]?.beats || 0 : null
    const seconds = Number(s.seconds) || (beats ?? 0) * beat
    const text = plain(s.caption || s.heading || items || s.name || '')
    // 操作示範的鏡頭多半沒有字：卡上顯示它對準的網頁上的字（「切換城市」）；那是截圖上的字，不能在這裡改
    const targets = [s.to, s.mark, s.press].filter((t): t is string => typeof t === 'string').map(t => `「${t}」`).join(' ')
    const shots = Array.isArray(s.images) ? `${s.images.length} 張截圖` : ''
    return {
      kind: shot ? SHOTS[shot]?.label ?? shot : String(s.kind ?? '?'),
      seconds: Math.round(seconds * 10) / 10,
      label: text || targets || shots,
      beats,
      ...(text ? {} : { fixedText: true }),
    }
  })
}

/** 讀一張 PNG 縮圖。PNG 只在載入時讀一次；之後每次重畫都用同一段 SVG 文字。 */
async function loadThumb($: $Like, path: string): Promise<Thumb> {
  const thumb = (await $.fs.exists(path)) ? path : null
  const png = thumb
    ? await ($.fs.read(thumb, { as: 'bytes' }) as Promise<unknown>).then(
        v => (v as { base64?: string }).base64 ?? null,
        () => null,
      )
    : null
  return { thumb, svg: thumbSvg(png) }
}

async function loadStyles($: $Like) {
  const dir = `${$.plugin.root}/skills/make-demo-video/styles`
  const found: StyleInfo[] = []
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const style = JSON.parse(await readText($, `${dir}/${entry.name}`)) as { id: string; name?: string }
      found.push({ id: style.id, name: style.name ?? style.id })
    } catch {
      // 壞掉的風格檔不擋面板，算圖時 render.mjs 會指出錯在哪
    }
  }
  styles = found
}

/** 讀 cuts/<id>/meta.json 與 thumb.png；預設剪法排第一，其餘照 id 排。 */
async function loadCuts($: $Like) {
  const dir = `${$.plugin.root}/skills/make-demo-video/cuts`
  const found: CutInfo[] = []
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind !== 'dir') continue
    try {
      const meta = JSON.parse(await readText($, `${dir}/${entry.name}/meta.json`)) as {
        id?: string
        name?: string
        suits?: string
        mode?: string
        defaults?: { aspect?: string; seconds?: number }
      }
      const d = meta.defaults ?? {}
      found.push({
        id: meta.id ?? entry.name,
        name: meta.name ?? entry.name,
        suits: meta.suits ?? '',
        mode: meta.mode ?? 'shots',
        defaults: {
          aspect: d.aspect === '9:16' || d.aspect === '16:9' ? d.aspect : undefined,
          seconds: typeof d.seconds === 'number' ? d.seconds : undefined,
        },
        ...(await loadThumb($, `${dir}/${entry.name}/thumb.png`)),
      })
    } catch {
      // 壞掉的剪法包不擋面板；cuts.test.mjs 會擋下格式錯誤
    }
  }
  cuts = found.sort((a, b) => (a.id === DEFAULT_CUT ? -1 : b.id === DEFAULT_CUT ? 1 : a.id.localeCompare(b.id)))
}

/** $.fs.read 的結果一律轉成文字（預設就是文字；保險起見也處理 bytes）。 */
async function readText($: $Like, path: string): Promise<string> {
  const value = (await $.fs.read(path)) as unknown
  if (typeof value === 'string') return value
  const base64 = (value as { base64?: string } | null)?.base64
  if (typeof base64 === 'string') return new TextDecoder().decode((Uint8Array as unknown as { fromBase64(b: string): Uint8Array }).fromBase64(base64))
  throw new Error(`讀到的不是文字（${typeof value}）`)
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 160)

/**
 * 從輸出資料夾重讀 script.md 與 storyboard.json；讀不到就保留目前內容，並把原因記在 note。
 * 分鏡表平常只讀這次開始後才改過的（上一次留下的不算數）；adopt 為真時表示 Claude 決定沿用它，不看修改時間。
 */
async function refresh($: $Like, adopt = false) {
  const r = await read($, run)
  if (!r.isActive || !r.out) return
  const patch: Partial<Run> = {}
  const notes: string[] = []
  const scriptPath = join(r.out, 'script.md')
  if (await $.fs.exists(scriptPath).catch(() => false)) {
    try {
      const script = parseScript(await readText($, scriptPath))
      if (script.length) patch.script = script
    } catch (err) {
      notes.push(`讀不到 ${scriptPath}：${reason(err)}`)
    }
  }
  const boardPath = join(r.out, 'storyboard.json')
  const stat = await $.fs.stat(boardPath).catch(() => null)
  if (stat && (adopt || stat.mtimeMs >= r.startedAt)) {
    try {
      const board = JSON.parse(await readText($, boardPath)) as { scenes?: unknown; aspect?: string }
      patch.scenes = toRows(board)
      if (board.aspect === '9:16' || board.aspect === '16:9') patch.choice = { ...r.choice, aspect: board.aspect }
    } catch (err) {
      notes.push(`讀不到 ${boardPath}：${reason(err)}`)
    }
  }
  await update($, run, x => ({ ...x, ...patch, note: notes.length ? notes.join('；') : null }))
}

/** 工具呼叫裡直接寫出的檔案：Write 的 file_path＋content，或 Bash 的 cat > 檔案 <<'EOF' … EOF。 */
function writesIn(e: unknown): { path: string; content: string }[] {
  const x = e as { tool?: string; file_path?: unknown; content?: unknown; command?: unknown }
  if (x.tool === 'Write' && typeof x.file_path === 'string' && typeof x.content === 'string') {
    return [{ path: x.file_path, content: x.content }]
  }
  if (x.tool !== 'Bash' || typeof x.command !== 'string') return []
  const found: { path: string; content: string }[] = []
  const heredoc = /cat\s*>\s*["']?([^\s"'<>]+)["']?\s*<<-?\s*["']?(\w+)["']?[^\n]*\n([\s\S]*?)\n\2(?:\n|$)/g
  for (const m of x.command.matchAll(heredoc)) {
    // 指令前面先 cd 到別的資料夾時（cd docs/demo && cat > storyboard.json …），相對路徑要接上那個資料夾
    const before = x.command.slice(0, m.index)
    const cd = [...before.matchAll(/(?:^|[;&|\n]\s*)cd\s+["']?([^\s"';&|]+)["']?/g)].at(-1)?.[1]
    const raw = m[1] ?? ''
    const path = raw.startsWith('/') || !cd ? raw : join(cd, raw)
    found.push({ path, content: m[3] ?? '' })
  }
  return found
}

/** Bash 指令跑 check.mjs 時檢查的分鏡表路徑（先 cd 到別的資料夾時接上那個資料夾）；沒跑 check.mjs 回傳 null。 */
const checkedBoard = (command: string) => pathArg(command, /check\.mjs[^\n;&|]*?--storyboard\s+["']?([^\s"';&|]+)/)
/** Bash 指令跑 signature.mjs beats／render 時的 reel.html 路徑。 */
const reelOf = (command: string, sub: 'beats' | 'render') =>
  pathArg(command, new RegExp(`signature\\.mjs["']?\\s+${sub}\\s+["']?([^\\s"';&|]+)`))

/** 指令裡 re 第一組抓到的路徑；先 cd 到別的資料夾時接上那個資料夾。 */
function pathArg(command: string, re: RegExp): string | null {
  const m = command.match(re)
  if (!m || m.index === undefined) return null
  const raw = m[1] ?? ''
  const cd = [...command.slice(0, m.index).matchAll(/(?:^|[;&|\n]\s*)cd\s+["']?([^\s"';&|]+)["']?/g)].at(-1)?.[1]
  return raw.startsWith('/') || !cd ? raw : join(cd, raw)
}

/** 檔案所在的資料夾；只有檔名、看不出資料夾時回傳 null（沿用目前的輸出資料夾）。 */
const dirOf = (path: string): string | null => (path.includes('/') ? path.replace(/\/[^/]*$/, '') || '/' : null)

async function start($: $Like) {
  const now = await $.clock.now()
  await update($, run, () => ({ ...FRESH, isActive: true, startedAt: now }))
  await $.ui.open({ id: PANE, title: 'make-demo-video' })
}

const absolute = (path: string) => (path.startsWith('/') || !cwd ? path : join(cwd, path))

/** 給 frames.mjs／render.mjs 的 --style：內建風格用 id，從素材定義的用輸出資料夾裡的 style.json。 */
const styleArg = (r: Run) => (r.choice.style === CUSTOM && r.out ? join(r.out, 'style.json') : r.choice.style)

/** render.mjs 指令裡的 --style 換回面板的風格代號。 */
function styleFromArg(arg: string): string {
  const base = arg.replace(/^.*\//, '')
  if (!base.endsWith('.json')) return base
  return base === 'style.json' ? CUSTOM : base.replace(/\.json$/, '')
}

/** 跑 frames.mjs 重算分鏡縮圖。失敗不擋流程，原因記在 note。 */
/** 縮圖一次只跑一個：跑的時候又被要求，就等它跑完再補跑一次（連按幾次都合併成一次）。 */
let framing: Promise<void> | null = null
let framingAgain = false
function regenFrames($: $Like): Promise<void> {
  if (framing) {
    framingAgain = true
    return framing
  }
  framing = (async () => {
    try {
      do {
        framingAgain = false
        await regenFramesOnce($)
      } while (framingAgain)
    } finally {
      framing = null
    }
  })()
  return framing
}

/** 面板上的編輯（讀分鏡表、改、寫回）一次只做一個：連按時不會兩個一起讀到舊內容、互相蓋掉。 */
let editing: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const done = editing.then(fn, fn)
  editing = done.catch(() => undefined)
  return done
}

/** Node 程式當掉時 stderr 最後一行是「Node.js v24…」：挑出真正的錯誤那一行。 */
function errorLine(stderr: string): string | null {
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^at\s/.test(line) && !/^Node\.js v/.test(line) && !/^\^+$/.test(line))
  return lines.find(line => /^\w*Error\b|錯誤|失敗|找不到/.test(line)) ?? lines.at(-1) ?? null
}

async function regenFramesOnce($: $Like) {
  const r = await read($, run)
  if (!r.out || r.scenes.length === 0) return
  const style = styleArg(r)
  await update($, run, x => ({ ...x, isFraming: true }))
  let note: string | null = null
  let ok = false
  try {
    const res = await $.process.run(
      [
        'node',
        `${$.plugin.root}/skills/make-demo-video/scripts/frames.mjs`,
        '--storyboard',
        join(r.out, 'storyboard.json'),
        '--style',
        style,
        '--out',
        join(r.out, 'frames'),
      ],
      { timeoutMs: 60_000 },
    )
    ok = res.exitCode === 0
    if (!ok) note = `分鏡縮圖產生失敗：${errorLine(res.stderr) ?? `結束碼 ${res.exitCode}`}`
  } catch (err) {
    note = `分鏡縮圖產生失敗：${reason(err)}`
  }
  // frames.mjs 順便做了分鏡自動檢查，結果在 frames/lint.json
  let lint: LintNote[] | null = null
  if (ok) {
    try {
      const parsed = JSON.parse(await readText($, join(r.out, 'frames/lint.json'))) as unknown
      lint = Array.isArray(parsed) ? (parsed as LintNote[]).filter(w => typeof w?.message === 'string') : []
    } catch {
      lint = []
    }
  }
  const now = await $.clock.now()
  // 失敗原因另外存：refresh 每次重讀都會重設 note，放在 note 裡會被下一個工具呼叫清掉
  await update($, run, x => ({ ...x, isFraming: false, framesAt: ok ? now : x.framesAt, lint: lint ?? x.lint, framesNote: note }))
}

/** 這次還沒算過縮圖，或分鏡表在上次算縮圖之後又改過（例如用 sed 改、面板認不出來）。 */
async function framesStale($: $Like): Promise<boolean> {
  const r = await read($, run)
  if (!r.out) return false
  if (r.framesAt === null) return true
  const stat = await $.fs.stat(join(r.out, 'storyboard.json')).catch(() => null)
  return Boolean(stat && stat.mtimeMs > r.framesAt)
}

/**
 * 縮圖的 SVG（VS Code 聊天面板等沒有 Image 的畫面用）。files 依序找第一個存在的檔案（小 JPEG 優先，舊版只有 PNG）。
 * 第 n 幕、第 n 拍各一張；version 是產生時間，換圖時快取自然失效。
 */
async function imageSvg($: $Like, files: string[], version: number, portrait: boolean): Promise<string | null> {
  for (const file of files) {
    const key = `${file}#${version}`
    const cached = imageSvgs.get(key)
    if (cached) return cached
    const base64 = await ($.fs.read(file, { as: 'bytes' }) as Promise<unknown>).then(
      v => (v as { base64?: string }).base64 ?? null,
      () => null,
    )
    if (!base64) continue
    const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png'
    const [w, h] = portrait ? [180, 320] : [320, 180]
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image href="data:${mime};base64,${base64}" width="${w}" height="${h}"/></svg>`
    imageSvgs.set(key, svg)
    return svg
  }
  return null
}

/** 依序放進縮圖，總量超過 budget 的改成 null（面板顯示文字），避免超過面板輸出上限。 */
function withinBudget(svgs: (string | null)[], budget: number): (string | null)[] {
  let used = 0
  return svgs.map(svg => {
    if (!svg || used + svg.length > budget) return null
    used += svg.length
    return svg
  })
}

/** 讀 signature.mjs beats 寫的 beats/beats.json；比 since 舊（上一次留下的）就不算。 */
async function loadBeats($: $Like, since: number) {
  const r = await read($, run)
  if (!r.out) return
  const file = join(r.out, 'beats/beats.json')
  const stat = await $.fs.stat(file).catch(() => null)
  if (!stat || stat.mtimeMs < since) return
  try {
    const parsed = JSON.parse(await readText($, file)) as { beats?: unknown; problems?: unknown }
    const beats = (Array.isArray(parsed.beats) ? parsed.beats : []).filter(
      (b): b is BeatRow => typeof (b as BeatRow)?.beat === 'number' && typeof (b as BeatRow)?.file === 'string',
    )
    const problems = (Array.isArray(parsed.problems) ? parsed.problems : []).map(String)
    const now = await $.clock.now()
    await update($, run, x => ({
      ...x,
      beats,
      beatsAt: now,
      beatProblems: [...new Set(problems)],
      isEdited: x.renderedAt !== null,
      isConceptPicking: false,
      openInput: null,
    }))
  } catch (err) {
    await update($, run, x => ({ ...x, note: `讀不到 ${file}：${reason(err)}` }))
  }
}

/** 改分鏡表；script.md 與分鏡一句一幕時，同一個動作也套到腳本上。 */
async function editScenesNow($: $Like, op: <T>(list: T[]) => T[]): Promise<boolean | undefined> {
  const r = await read($, run)
  if (!r.out) return
  const boardPath = join(r.out, 'storyboard.json')
  const board = JSON.parse(await readText($, boardPath)) as { scenes: unknown[] }
  const before = board.scenes.length
  board.scenes = op([...board.scenes])
  await $.fs.write(boardPath, JSON.stringify(board, null, 2) + '\n')
  const scriptPath = join(r.out, 'script.md')
  if (await $.fs.exists(scriptPath)) {
    const lines = parseScript(await readText($, scriptPath))
    if (lines.length === before) {
      await $.fs.write(scriptPath, op([...lines]).map((line, i) => `${i + 1}. ${line}`).join('\n') + '\n')
    }
  }
  await update($, run, x => ({ ...x, isEdited: true, openInput: null }))
  await refresh($)
  return true
}

/** 連按時排隊改檔，縮圖等改完再重算（重算合併成一次）。 */
async function editScenes($: $Like, op: <T>(list: T[]) => T[]) {
  if (await serial(() => editScenesNow($, op))) await regenFrames($)
}

/**
 * 第 i 幕加長或縮短（delta 是 +1 或 -1）：用鏡頭模板時一次一拍，其他幕一次 0.5 秒。總長跟著變，其他幕不動。
 * 範圍：模板幕 1–12 拍、其他幕 0.5–10 秒。快節奏建議單幕不超過 3 秒，但讓使用者自己決定：
 * 超過時自動檢查會在那張卡上提醒（不擋算圖）。
 */
function durationLimits(row: SceneRow): { min: number; max: number } {
  if (row.beats != null) return { min: 1, max: 12 }
  return { min: 0.5, max: 10 }
}

async function editDurationNow($: $Like, i: number, delta: 1 | -1): Promise<boolean | undefined> {
  const r = await read($, run)
  const row = r.scenes[i]
  if (!r.out || !row) return
  const boardPath = join(r.out, 'storyboard.json')
  const board = JSON.parse(await readText($, boardPath)) as { scenes: Record<string, unknown>[] }
  const scene = board.scenes[i]
  if (!scene) return
  const { min, max } = durationLimits(row)
  if (row.beats != null) {
    const next = Math.max(min, Math.min(max, row.beats + delta))
    if (next === row.beats) return
    scene.beats = next
  } else {
    const next = Math.max(min, Math.min(max, Math.round((row.seconds + delta * 0.5) * 10) / 10))
    if (next === row.seconds) return
    scene.seconds = next
  }
  await $.fs.write(boardPath, JSON.stringify(board, null, 2) + '\n')
  await update($, run, x => ({ ...x, isEdited: true, openInput: null }))
  await refresh($)
  return true
}

/** 連按時排隊改檔，縮圖等改完再重算（重算合併成一次）。 */
async function editDuration($: $Like, i: number, delta: 1 | -1) {
  if (await serial(() => editDurationNow($, i, delta))) await regenFrames($)
}

/** 改第 i 句的字：寫回 script.md（一句一幕時）與這一幕的字幕（用鏡頭模板、title／outro 是 heading；phone／card 沒有 caption 時也是 heading；其他是 caption）。 */
async function editLineNow($: $Like, i: number, text: string): Promise<boolean | undefined> {
  const r = await read($, run)
  if (!r.out || !text) return
  const boardPath = join(r.out, 'storyboard.json')
  const board = JSON.parse(await readText($, boardPath)) as { scenes: Record<string, unknown>[] }
  const scene = board.scenes[i]
  if (!scene) return
  const big = Boolean(scene.shot) || scene.kind === 'title' || scene.kind === 'outro' || ((scene.kind === 'phone' || scene.kind === 'card') && !scene.caption)
  scene[big ? 'heading' : 'caption'] = text
  await $.fs.write(boardPath, JSON.stringify(board, null, 2) + '\n')
  const scriptPath = join(r.out, 'script.md')
  if (await $.fs.exists(scriptPath)) {
    const lines = parseScript(await readText($, scriptPath))
    if (lines.length === board.scenes.length) {
      lines[i] = text
      await $.fs.write(scriptPath, lines.map((line, n) => `${n + 1}. ${line}`).join('\n') + '\n')
    }
  }
  await update($, run, x => ({ ...x, isEdited: true, openInput: null }))
  await refresh($)
  return true
}

/** 連按時排隊改檔，縮圖等改完再重算（重算合併成一次）。 */
async function editLine($: $Like, i: number, text: string) {
  if (await serial(() => editLineNow($, i, text))) await regenFrames($)
}

/** 改腳本（上移、刪除、新增一句），寫回 script.md；分鏡表要等使用者按「照腳本重排分鏡」才改。 */
function editScript($: $Like, op: (list: string[]) => string[]) {
  return serial(() => editScriptNow($, op))
}

async function editScriptNow($: $Like, op: (list: string[]) => string[]) {
  const r = await read($, run)
  if (!r.out) return
  const scriptPath = join(r.out, 'script.md')
  const current = await readText($, scriptPath).then(parseScript, () => r.script)
  const next = op([...current]).map(line => line.trim()).filter(Boolean)
  await $.fs.write(scriptPath, next.map((line, i) => `${i + 1}. ${line}`).join('\n') + '\n')
  await update($, run, x => ({ ...x, script: next, isScriptEdited: true }))
}

const moveUp = (i: number) => <T,>(list: T[]) => [...list.slice(0, i - 1), ...list.slice(i, i + 1), ...list.slice(i - 1, i), ...list.slice(i + 1)]
const moveDown = (i: number) => moveUp(i + 1)
const remove = (i: number) => <T,>(list: T[]) => list.filter((_, j) => j !== i)

function styleLabel(id: string) {
  if (id === CUSTOM) return '從素材定義風格'
  const s = styles.find(x => x.id === id)
  return s ? `${s.name}（${s.id}）` : id
}

function cutLabel(id: string) {
  const c = cuts.find(x => x.id === id)
  return c ? `${c.name}（${c.id}）` : id
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = (e as unknown as { cwd?: string }).cwd ?? ''
    await Promise.all([loadStyles($), loadCuts($)])
    await $.command.register({ name: 'demo-panel', description: '打開 make-demo-video 的四步進度面板' })
    await $.tool.register({
      name: TOOL_NAME,
      description:
        'make-demo-video 的 ① 剪法與設定：讀完素材、寫腳本之前呼叫。在面板上顯示剪法（縮圖、適合什麼、你的推薦理由）、' +
        '比例（16:9／9:16）、秒數、幕數讓使用者選；外觀一律從素材取色。' +
        '呼叫後輸出 ① 進度行並結束這一回合；使用者按「確定」後，下一則訊息會是「① 選好了：…」，照選的剪法寫腳本（②）。',
      inputSchema: {
        type: 'object',
        properties: {
          out: { type: 'string', description: '輸出資料夾，例如 docs/demo' },
          cuts: {
            type: 'array',
            items: { type: 'string' },
            description: '依素材推薦的剪法 id（cuts/<id>/），最多三個，第一個是預設選取',
          },
          reason: {
            type: 'string',
            description: '一句話說明為什麼第一個剪法適合這次的素材，要提到素材本身（例如「作品集網站、截圖完整，適合捲動導覽」）',
          },
          scenes: { type: 'integer', description: '建議幕數；已備好腳本時是腳本句數' },
          seconds: { type: 'integer', description: '建議的總秒數' },
        },
        required: ['out'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: CONCEPT_TOOL,
      description:
        'make-demo-video 生成式剪法（招牌片）的 ③ 概念：使用者選好剪法、腳本寫好之後呼叫。在面板上列出概念讓使用者挑一個（也可以「你來決定」或自己寫）。' +
        '呼叫後輸出 ③ 概念進度行並結束這一回合；使用者挑好後，下一則訊息會是「③ 概念選好了：…」，照它寫 beats.md 與 reel.html。',
      inputSchema: {
        type: 'object',
        properties: {
          out: { type: 'string', description: '輸出資料夾，例如 docs/demo' },
          concepts: {
            type: 'array',
            items: { type: 'string' },
            description: '三個概念，每個一行「A 變成 B 變成 C」，最後回到 A；第一個是你推薦的',
          },
        },
        required: ['concepts'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('command.run', { command: 'demo-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'make-demo-video' })
    return { text: '已打開 make-demo-video 面板。' }
  })

  // 面板出錯不能擋住使用者的訊息或 Claude 的工具呼叫：出錯就照原樣放行（next 已呼叫過時只是重播結果）。
  on('prompt.submit', async ($, e, next) => {
    if (/^\s*\/make-demo-video\b/.test(e.text ?? '')) await start($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.run', { tool: 'mcp__make-demo-video__show_options' }, async ($, e) => {
    const args = ((e as unknown as { input?: object }).input ?? e) as {
      out?: unknown
      cuts?: unknown
      reason?: unknown
      scenes?: unknown
      seconds?: unknown
    }
    if (cuts.length === 0) await loadCuts($)
    const out = typeof args.out === 'string' && args.out ? await outDir($, args.out) : null
    const cutIds = new Set(cuts.map(c => c.id))
    const suggested = (Array.isArray(args.cuts) ? args.cuts : []).map(String).filter(id => cutIds.has(id)).slice(0, 3)
    const r = await read($, run)
    if (!r.isActive) await start($)
    await update($, run, x => {
      const cut = suggested[0] ?? (cutIds.has(x.choice.cut) ? x.choice.cut : cuts[0]?.id ?? DEFAULT_CUT)
      const defaults = cuts.find(c => c.id === cut)?.defaults ?? {}
      return {
        ...x,
        out: out ?? x.out,
        suggested,
        reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null,
        isPicking: true,
        isChosen: false,
        choice: {
          cut,
          style: CUSTOM,
          aspect: defaults.aspect ?? x.choice.aspect,
          scenes: clamp(Number(args.scenes) || x.script.length || x.choice.scenes, MIN_SCENES, MAX_SCENES),
          seconds: nearestSeconds(Number(args.seconds) || defaults.seconds || x.choice.seconds),
        },
      }
    })
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'make-demo-video', focus: true })
    // 沒有畫面能放面板（例如 claude -p）時，交給 .catch 改用對話框問
    if (!opened.isPlaced) throw new Error('pane not placed')
    return {
      result:
        '選項已顯示在 make-demo-video 面板上。現在輸出 ① 進度行（例如「① 剪法｜請在右側面板選擇剪法、比例、秒數與幕數」），然後結束這一回合，不要再呼叫其他工具，也還不要寫腳本。' +
        '使用者按「確定」後，下一則訊息會是「① 選好了：…」。',
    } as never
  }).catch(() => ({ deny: 'make-demo-video 面板無法顯示選項：請改用 AskUserQuestion 問使用者（剪法、比例、秒數、幕數）。' }))

  on('tool.run', { tool: `mcp__make-demo-video__${CONCEPT_TOOL}` }, async ($, e) => {
    const args = ((e as unknown as { input?: object }).input ?? e) as { out?: unknown; concepts?: unknown }
    const concepts = (Array.isArray(args.concepts) ? args.concepts : []).map(c => plain(c).trim()).filter(Boolean).slice(0, 4)
    if (concepts.length < 2) return { deny: 'show_concepts 至少要給兩個概念（建議三個）。' }
    const r = await read($, run)
    if (!r.isActive) await start($)
    const out = typeof args.out === 'string' && args.out ? await outDir($, args.out) : null
    await update($, run, x => ({
      ...x,
      out: out ?? x.out,
      concepts,
      isConceptPicking: true,
      concept: null,
      openInput: null,
    }))
    const opened = await $.ui.open({ id: PANE, title: 'make-demo-video', focus: true })
    if (!opened.isPlaced) throw new Error('pane not placed')
    return {
      result:
        '概念已顯示在 make-demo-video 面板的 ③。現在輸出 ③ 進度行（例如「③ 概念｜請在右側面板挑一個概念」），然後結束這一回合，不要再呼叫其他工具。' +
        '使用者挑好後，下一則訊息會是「③ 概念選好了：…」。',
    } as never
  }).catch(() => ({ deny: 'make-demo-video 面板無法顯示概念：請改用 AskUserQuestion 問使用者要哪個概念。' }))

  // 每個工具呼叫結束後：認出輸出資料夾、認出算圖完成，再重讀檔案。
  on('tool.call', async ($, e, next) => {
    // 指令裡的相對路徑照「執行前」的工作目錄解析（指令裡的 cd 會留到之後）
    const base = await $.session.cwd().catch(() => cwd)
    const ran = await next(e)
    const r = await read($, run)
    if (!r.isActive) {
      const skill = String((e as unknown as { skill?: string }).skill ?? '')
      if (e.tool !== 'Skill' || !skill.includes('make-demo-video')) return ran
      await start($)
    }
    // 先用工具呼叫裡寫出的內容更新（不必等讀檔），輸出資料夾也以實際寫入的位置為準
    let wroteBoard = false
    let styleChanged = false
    for (const w of writesIn(e).map(x => ({ ...x, path: resolveIn(base, x.path) }))) {
      if (w.path.endsWith('script.md')) {
        const script = parseScript(w.content)
        await update($, run, x => ({ ...x, out: dirOf(w.path) ?? x.out, script: script.length ? script : x.script }))
      } else if (w.path.endsWith('storyboard.json')) {
        try {
          const scenes = toRows(JSON.parse(w.content) as { scenes?: unknown })
          await update($, run, x => ({
            ...x,
            out: dirOf(w.path) ?? x.out,
            scenes,
            isScriptEdited: false,
            isEdited: x.renderedAt !== null,
            openInput: null,
          }))
          wroteBoard = true
        } catch {
          await update($, run, x => ({ ...x, out: dirOf(w.path) ?? x.out }))
        }
      }
    }
    const blob = JSON.stringify(e)
    if (!(await read($, run)).out) {
      const m = blob.match(/([\w.~/-]*\/)?(?:script\.md|storyboard\.json)/)
      if (m) await update($, run, x => ({ ...x, out: resolveIn(base, (m[1] ?? '').replace(/\/+$/, '') || '.') }))
    }
    const command = String((e as unknown as { command?: string }).command ?? '')
    if (e.tool === 'Bash' && /render\.mjs/.test(command) && !('deny' in ran && ran.deny)) {
      const output = JSON.stringify((ran as { result?: unknown }).result ?? '')
      const took = output.match(/花了 ([\d.]+) 秒/)
      const style = command.match(/--style\s+["']?([^\s"']+)/)
      const used = style ? styleFromArg(style[1] ?? '') : null
      const before = (await read($, run)).choice.style
      const now = await $.clock.now()
      await update($, run, x => ({
        ...x,
        renderedAt: took ? now : x.renderedAt,
        renderSeconds: took ? Number(took[1]) : x.renderSeconds,
        isEdited: took ? false : x.isEdited,
        isChosen: x.isChosen || Boolean(used),
        choice: used ? { ...x.choice, style: used } : x.choice,
      }))
      // 風格換了（例如使用者在對話裡說「換成霓虹」），分鏡縮圖也換成新風格
      if (used && used !== before) styleChanged = true
    }
    // 招牌片：寫或改了 reel.html（算過圖之後）就要重新合成；跑完 signature.mjs beats 讀逐拍分鏡板；signature.mjs render 跑完就是 ④ 完成
    const edited = e.tool === 'Edit' ? String((e as unknown as { file_path?: string }).file_path ?? '') : ''
    if (r.renderedAt !== null && (edited.endsWith('reel.html') || writesIn(e).some(w => w.path.endsWith('reel.html')))) {
      await update($, run, x => ({ ...x, isEdited: true }))
    }
    const beatsReel = e.tool === 'Bash' ? reelOf(command, 'beats') : null
    if (beatsReel) {
      if (!(await read($, run)).out) await update($, run, x => ({ ...x, out: dirOf(resolveIn(base, beatsReel)) }))
      await loadBeats($, (await read($, run)).beatsAt ?? r.startedAt)
    }
    if (e.tool === 'Bash' && reelOf(command, 'render') && !('deny' in ran && ran.deny)) {
      const took = JSON.stringify((ran as { result?: unknown }).result ?? '').match(/花了 ([\d.]+) 秒/)
      if (took) {
        const now = await $.clock.now()
        await update($, run, x => ({ ...x, renderedAt: now, renderSeconds: Number(took[1]), isEdited: false, isChosen: true }))
      }
    }
    // Claude 跑 check.mjs 檢查輸出資料夾裡的分鏡表：就算這次沒寫過它（沿用上一次留下的），也當成這次的分鏡板
    let adopted = false
    const checked = e.tool === 'Bash' ? checkedBoard(command) : null
    if (checked) {
      const dir = dirOf(resolveIn(base, checked))
      const out = (await read($, run)).out
      if (!out) await update($, run, x => ({ ...x, out: dir }))
      adopted = !out || dir === resolveIn(base, out)
    }
    await refresh($, adopted)
    // Claude 改了分鏡表（含 Edit 工具）：重算分鏡縮圖。process.run 等待的時間不算進這個 hook 的時間預算。
    const touchedBoard = wroteBoard || (e.tool === 'Edit' && String((e as unknown as { file_path?: string }).file_path ?? '').endsWith('storyboard.json'))
    if (touchedBoard || styleChanged || (adopted && (await framesStale($)))) await regenFrames($)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input } = els
    const Image = e.surface === 'terminal' && 'Image' in els ? els.Image : null
    const Svg = 'Svg' in els ? els.Svg : null
    if (styles.length === 0) await loadStyles($)
    if (cuts.length === 0) await loadCuts($)
    const r = await read($, run)
    const cols = Math.max(24, e.props.bodyColumns ?? 40)

    if (!r.isActive) {
      return (
        <Box flexDirection="column">
          <Text bold>make-demo-video</Text>
          <Text dimColor>輸入 /make-demo-video 開始；面板會跟著 ① 剪法 → ② 腳本 → ③ 分鏡 → ④ 算圖 前進。</Text>
        </Box>
      )
    }

    // 生成式剪法（招牌片）的 ③ 是逐拍分鏡板，不是分鏡表
    const generate = cuts.find(k => k.id === r.choice.cut)?.mode === 'generate'
    const hasBoard = generate ? r.beats.length > 0 : r.scenes.length > 0
    // ① 在使用者指定好一切、Claude 跳過面板時，寫出腳本或分鏡表也算選好了
    const done = [
      !r.isPicking && (r.isChosen || r.script.length > 0 || hasBoard),
      r.script.length > 0,
      hasBoard,
      r.renderedAt !== null && !r.isEdited,
    ]
    const current = done.indexOf(false)
    const setChoice = (patch: Partial<Choice>) => update($, run, x => ({ ...x, choice: { ...x.choice, ...patch } }))

    const head = (i: number, title: string, detail: string) => (
      <Text>
        <Text color={done[i] ? 'success' : i === current ? 'warning' : 'inactive'}>
          {done[i] ? '✔' : i === current ? '●' : '○'}
        </Text>{' '}
        <Text bold={i === current}>{i + 1}. {title}</Text> <Text dimColor>{detail}</Text>
      </Text>
    )

    // ② 腳本
    const scriptStep = (
      <Box flexDirection="column">
        {head(
          1,
          '腳本',
          done[1]
            ? `${join(r.out ?? '', 'script.md')}・${r.script.length} 句${hasBoard ? '（在下方分鏡板編輯）' : ''}`
            : current === 1
              ? `照剪法 ${cutLabel(r.choice.cut)} 寫腳本中…`
              : '',
        )}
        {(hasBoard ? [] : r.script).map((line, i) => (
          <Box flexDirection="row" paddingLeft={3}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">
                {String(i + 1).padStart(2)}. {line}
              </Text>
            </Box>
            {r.out && i > 0 ? <Button key={`line-up-${i}`} label="↑" onPress={() => editScript($, moveUp(i))} /> : <Text>   </Text>}
            {r.out && i < r.script.length - 1 ? (
              <Button key={`line-down-${i}`} label="↓" onPress={() => editScript($, moveDown(i))} />
            ) : (
              <Text>   </Text>
            )}
            {r.out && r.script.length > 1 ? (
              <Button key={`line-del-${i}`} label="✕" onPress={() => editScript($, remove(i))} />
            ) : null}
          </Box>
        ))}
        {r.out && done[1] && !hasBoard ? (
          <Box paddingLeft={3}>
            <Input
              key="line-add"
              placeholder="新增一句（20 字以內）…"
              submitLabel="加入"
              onSubmit={value => (value.trim() ? editScript($, list => [...list, value]) : undefined)}
            />
          </Box>
        ) : null}
      </Box>
    )

    // ① 剪法與設定：剪法大卡（主角）、比例、秒數、幕數；外觀一律從素材取色
    const c = r.choice
    const pick = r.isPicking && !r.isChosen
    const thumbBox = (t: Thumb & { id: string; name: string }, cellCols: number, rows: number, key: string, fallback: string) =>
      Image && t.thumb ? (
        <Image key={key} source={{ file: t.thumb, format: 'png' }} columns={cellCols} rows={rows} alt={t.name} />
      ) : Svg && t.svg ? (
        <Svg source={t.svg} alt={t.name} width={cellCols * 8} height={cellCols * 4.5} />
      ) : (
        <Text dimColor>{fallback}</Text>
      )

    const cutCols = 20
    const cutsPerRow = Math.max(1, Math.min(3, Math.floor((cols - 3) / (cutCols + 1))))
    const cutRows: CutInfo[][] = []
    for (let i = 0; i < cuts.length; i += cutsPerRow) cutRows.push(cuts.slice(i, i + cutsPerRow))
    const cutCard = (k: CutInfo, i: number) => {
      const isOn = c.cut === k.id
      return (
        <Box flexDirection="column" width={cutCols} marginRight={1}>
          {thumbBox(k, cutCols, 5, `cut-thumb-${k.id}`, ' ')}
          <Button
            key={`cut-${k.id}`}
            label={`${isOn ? '●' : '○'} ${i + 1} ${k.name}`}
            hotkey={String(i + 1)}
            variant={isOn ? 'primary' : 'secondary'}
            onPress={() => setChoice({ cut: k.id })}
          />
          {r.suggested.includes(k.id) ? <Text color="warning">推薦</Text> : null}
          <Text dimColor wrap="wrap">
            {k.suits}
          </Text>
        </Box>
      )
    }

    const choiceButton = (key: string, label: string, isOn: boolean, onPress: () => unknown) => (
      <Button key={key} label={`${isOn ? '●' : '○'} ${label}`} variant={isOn ? 'primary' : 'secondary'} onPress={onPress} />
    )
    const confirm = async () => {
      const x = await read($, run)
      const was = x.pickedFrom
      const now = x.choice
      await update($, run, y => ({ ...y, isChosen: true, isPicking: false, pickedFrom: null }))
      const isGen = cuts.find(k => k.id === now.cut)?.mode === 'generate'
      const summary = `剪法 ${cutLabel(now.cut)}、比例 ${now.aspect}、約 ${now.seconds} 秒${isGen ? '' : `、${now.scenes} 幕`}`
      const hasWork = x.scenes.length > 0 || x.beats.length > 0
      if (was && was.cut !== now.cut && (x.script.length > 0 || hasWork)) {
        // 剪法決定腳本怎麼寫：換剪法就要照新剪法重寫腳本，再重排分鏡
        await $.prompt.submit({
          text: `① 改選：${summary}（原本剪法 ${cutLabel(was.cut)}）；照新剪法重寫 script.md 與分鏡表`,
        })
        return
      }
      if (!was || !hasWork) {
        await $.prompt.submit({ text: `① 選好了：${summary}` })
        return
      }
      if (isGen) {
        if (was.aspect !== now.aspect || was.seconds !== now.seconds) {
          await $.prompt.submit({
            text: `① 改選：${summary}（原本 ${was.aspect}、約 ${was.seconds} 秒）；概念不變，照新設定改寫 reel.html`,
          })
        }
        return
      }
      const replan = was.aspect !== now.aspect || was.seconds !== now.seconds || was.scenes !== now.scenes
      if (replan) {
        await $.prompt.submit({
          text: `① 改選：${summary}（原本 ${was.aspect}、約 ${was.seconds} 秒、${was.scenes} 幕）；照新設定重排分鏡表`,
        })
      }
    }
    const repick = () =>
      update($, run, x => ({ ...x, isPicking: true, isChosen: false, pickedFrom: x.choice, openInput: null }))
    const pickStep = (
      <Box flexDirection="column">
        {head(
          0,
          '剪法與設定',
          done[0] || r.isChosen
            ? `${cutLabel(c.cut)}・${generate ? '從素材取色' : styleLabel(c.style)}・${c.aspect}・${c.seconds} 秒${generate ? '' : `・${c.scenes} 幕`}`
            : pick
              ? r.pickedFrom
                ? '重新選，按「確定」'
                : '請選擇，按「確定」'
              : '讀素材中…',
        )}
        {r.isChosen && !pick ? (
          <Box paddingLeft={3}>
            <Button key="repick" label="↺ 重新選" onPress={repick} />
          </Box>
        ) : null}
        {pick ? (
          <Box flexDirection="column" paddingLeft={3}>
            {cutRows.map((row, ri) => (
              <Box flexDirection="row">{row.map((k, ci) => cutCard(k, ri * cutsPerRow + ci))}</Box>
            ))}
            {r.reason ? (
              <Text wrap="wrap">
                <Text color="warning">Claude：</Text>
                {r.reason}
              </Text>
            ) : null}
            <Box flexDirection="row">
              <Text>比例 </Text>
              {(['16:9', '9:16'] as Aspect[]).map(a =>
                choiceButton(`aspect-${a}`, a === '16:9' ? '16:9 橫式' : '9:16 直式', c.aspect === a, () => setChoice({ aspect: a })),
              )}
            </Box>
            <Box flexDirection="row">
              <Text>秒數 </Text>
              {SECONDS.map(s => choiceButton(`sec-${s}`, `${s}s`, c.seconds === s, () => setChoice({ seconds: s })))}
            </Box>
            {generate ? null : <Box flexDirection="row">
              <Text>幕數 </Text>
              <Button key="scenes-down" label="−" onPress={() => setChoice({ scenes: clamp(c.scenes - 1, MIN_SCENES, MAX_SCENES) })} />
              <Text> {c.scenes} 幕 </Text>
              <Button key="scenes-up" label="+" onPress={() => setChoice({ scenes: clamp(c.scenes + 1, MIN_SCENES, MAX_SCENES) })} />
              {r.script.length > 0 && c.scenes !== r.script.length ? (
                <Text dimColor> （腳本 {r.script.length} 句，Claude 會調整成 {c.scenes} 句）</Text>
              ) : null}
            </Box>}
            <Button key="confirm" label="確定 ↵" variant="primary" autoFocus onPress={confirm} />
          </Box>
        ) : null}
      </Box>
    )

    // ③ 分鏡板：一張卡＝一句腳本＋這一幕的縮圖
    const total = r.scenes.reduce((sum, s) => sum + s.seconds, 0)
    const portrait = c.aspect === '9:16'
    const linked = r.script.length === r.scenes.length
    const framesAt = r.framesAt ?? 0
    const framePath = (i: number) => join(join(r.out ?? '', 'frames'), `scene-${i + 1}.png`)
    // 縮圖 SVG 的額度：扣掉 ① 剪法卡縮圖（只有選剪法時才畫）
    const budget = SVG_BUDGET - (pick && !Image ? cuts.reduce((sum, k) => sum + (k.svg?.length ?? 0), 0) : 0)
    const svgs =
      Svg && !Image && r.framesAt && !generate
        ? withinBudget(
            await Promise.all(r.scenes.map((_, i) => imageSvg($, [framePath(i).replace(/\.png$/, '.jpg'), framePath(i)], framesAt, portrait))),
            budget,
          )
        : []
    const thumbOf = (i: number) => {
      if (!r.framesAt) return <Text dimColor>{r.isFraming ? '產生縮圖中…' : ' '}</Text>
      if (Image) {
        return (
          <Image
            key={`frame-${i}`}
            source={{ file: absolute(framePath(i)), format: 'png', generation: framesAt }}
            columns={portrait ? 6 : 16}
            rows={portrait ? 6 : 4}
            alt={`第 ${i + 1} 幕`}
          />
        )
      }
      const svg = svgs[i]
      return Svg && svg ? <Svg source={svg} alt={`第 ${i + 1} 幕`} width={portrait ? 54 : 128} height={portrait ? 96 : 72} /> : <Text> </Text>
    }
    const ask = (text: string) => $.prompt.submit({ text })
    const card = (s: SceneRow, i: number) => {
      const line = linked ? r.script[i] ?? s.label : s.label
      const input = r.openInput?.index === i ? r.openInput : null
      return (
        <Box flexDirection="column" paddingLeft={3}>
          <Box flexDirection="row" gap={1}>
            {thumbOf(i)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row">
                <Text dimColor>
                  {i + 1} ・ {s.kind} ・{' '}
                </Text>
                {(s.beats ?? s.seconds) > durationLimits(s).min ? (
                  <Button key={`shorter-${i}`} label="−" onPress={() => editDuration($, i, -1)} />
                ) : null}
                <Text>
                  {' '}
                  {s.seconds}s{' '}
                </Text>
                {(s.beats ?? s.seconds) < durationLimits(s).max ? (
                  <Button key={`longer-${i}`} label="＋" onPress={() => editDuration($, i, 1)} />
                ) : null}
              </Box>
              <Text wrap="wrap">{line}</Text>
              {r.lint
                .filter(w => w.row === i)
                .map((w, n) => (
                  <Text key={`lint-${i}-${n}`} color="warning" wrap="wrap">
                    ⚠ {w.message}
                  </Text>
                ))}
              <Box flexDirection="row">
                {i > 0 ? <Button key={`up-${i}`} label="↑" onPress={() => editScenes($, moveUp(i))} /> : null}
                {i < r.scenes.length - 1 ? <Button key={`down-${i}`} label="↓" onPress={() => editScenes($, moveDown(i))} /> : null}
                {r.scenes.length > 2 ? <Button key={`del-${i}`} label="✕" onPress={() => editScenes($, remove(i))} /> : null}
                <Button
                  key={`insert-${i}`}
                  label="＋ 插一句"
                  onPress={() => update($, run, x => ({ ...x, openInput: input?.kind === 'insert' ? null : { kind: 'insert' as const, index: i } }))}
                />
                {s.fixedText ? null : (
                  <Button
                    key={`edit-${i}`}
                    label="✎ 改字"
                    onPress={() => update($, run, x => ({ ...x, openInput: input?.kind === 'edit' ? null : { kind: 'edit' as const, index: i } }))}
                  />
                )}
                <Button
                  key={`redo-${i}`}
                  label="⟳ 重畫"
                  onPress={() => update($, run, x => ({ ...x, openInput: input?.kind === 'redo' ? null : { kind: 'redo' as const, index: i } }))}
                />
              </Box>
            </Box>
          </Box>
          {input?.kind === 'insert' ? (
            <Input
              key={`insert-input-${i}`}
              placeholder={`在第 ${i + 1} 幕後面插一句（20 字以內）…`}
              submitLabel="插入"
              autoFocus
              onSubmit={async value => {
                const text = value.trim()
                if (!text) return
                if (linked) await editScript($, list => [...list.slice(0, i + 1), text, ...list.slice(i + 1)])
                await update($, run, x => ({ ...x, openInput: null }))
                await ask(
                  `插入一幕：在第 ${i + 1} 幕後面插入一句「${text}」${linked ? '（script.md 已更新）' : ''}；只為這句補一幕，其他幕不動`,
                )
              }}
            />
          ) : null}
          {input?.kind === 'edit' ? (
            <Input
              key={`edit-input-${i}`}
              value={line}
              placeholder="這一句改成…"
              submitLabel="改好了"
              autoFocus
              onSubmit={value => editLine($, i, value.trim())}
            />
          ) : null}
          {input?.kind === 'redo' ? (
            <Input
              key={`redo-input-${i}`}
              placeholder="想怎麼改這一幕？例如「推近到搜尋框」，留空就換個呈現方式"
              submitLabel="重畫"
              autoFocus
              onSubmit={async value => {
                await update($, run, x => ({ ...x, openInput: null }))
                await ask(`重畫第 ${i + 1} 幕：${value.trim() || '換一個呈現方式'}；只改這一幕，腳本的字不變`)
              }}
            />
          ) : null}
        </Box>
      )
    }
    // ③（招牌片）：挑概念 → 逐拍分鏡板，一小節一排，每拍可以留意見給 Claude 只改那一拍
    const beatsAt = r.beatsAt ?? 0
    const beatSvgs =
      Svg && !Image && generate && r.beatsAt
        ? withinBudget(
            await Promise.all(r.beats.map(b => imageSvg($, [b.thumb, b.file].filter((f): f is string => Boolean(f)).map(f => join(r.out ?? '', f)), beatsAt, portrait))),
            budget,
          )
        : []
    const perBar = 4
    const bars: BeatRow[][] = []
    for (let i = 0; i < r.beats.length; i += perBar) bars.push(r.beats.slice(i, i + perBar))
    const beatThumb = (b: BeatRow, i: number) => {
      if (Image) {
        return (
          <Image
            key={`beat-img-${i}`}
            source={{ file: absolute(join(r.out ?? '', b.file)), format: 'png', generation: beatsAt }}
            columns={portrait ? 6 : 12}
            rows={portrait ? 6 : 3}
            alt={`第 ${b.beat} 拍`}
          />
        )
      }
      const svg = beatSvgs[i]
      return Svg && svg ? <Svg source={svg} alt={`第 ${b.beat} 拍`} width={portrait ? 54 : 96} height={portrait ? 96 : 54} /> : <Text dimColor>（縮圖略）</Text>
    }
    const pickConcept = async (text: string | null) => {
      await update($, run, x => ({ ...x, isConceptPicking: false, concept: text ?? '你來決定' }))
      await ask(text ? `③ 概念選好了：${text}` : '③ 概念選好了：你來決定（從面板上的概念挑最適合的）')
    }
    const openBeat = r.openInput?.kind === 'beat' ? r.openInput.index : null
    const step3Generate = (
      <Box flexDirection="column" gap={1}>
        {head(
          2,
          '逐拍分鏡板',
          hasBoard
            ? `${join(r.out ?? '', 'reel.html')}・${r.beats.length} 拍${r.beatProblems.length ? `・檢查有 ${r.beatProblems.length} 項沒過` : '・檢查通過'}`
            : r.isConceptPicking
              ? '挑一個貫穿全片的概念'
              : r.concept
                ? '照概念寫 reel.html 中…'
                : '',
        )}
        {r.isConceptPicking ? (
          <Box flexDirection="column" paddingLeft={3}>
            <Text dimColor wrap="wrap">
              第一格與最後一格相同，影片可以循環。
            </Text>
            {r.concepts.map((concept, i) => (
              <Box flexDirection="row" gap={1}>
                <Button key={`concept-${i}`} label={`${i + 1}`} hotkey={String(i + 1)} variant={i === 0 ? 'primary' : 'secondary'} onPress={() => pickConcept(concept)} />
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="wrap">
                    {concept}
                    {i === 0 ? <Text color="warning">（推薦）</Text> : null}
                  </Text>
                </Box>
              </Box>
            ))}
            <Box flexDirection="row" gap={1}>
              <Button key="concept-auto" label="你來決定" onPress={() => pickConcept(null)} />
            </Box>
            <Input
              key="concept-own"
              placeholder="或寫你自己的概念：A 變成 B 變成 C，最後回到 A…"
              submitLabel="用這個"
              onSubmit={value => (value.trim() ? pickConcept(value.trim()) : undefined)}
            />
          </Box>
        ) : r.concept ? (
          <Box paddingLeft={3}>
            <Text wrap="wrap">
              <Text dimColor>概念：</Text>
              {r.concept}
            </Text>
          </Box>
        ) : null}
        {r.beatProblems.map((p, n) => (
          <Text key={`beat-problem-${n}`} color="warning" wrap="wrap">
            {'   '}⚠ {p}
          </Text>
        ))}
        {bars.map((bar, bi) => (
          <Box flexDirection="column" paddingLeft={3}>
            <Text dimColor>
              第 {bi + 1} 小節
            </Text>
            <Box flexDirection="row" gap={1}>
              {bar.map((b, j) => {
                const i = bi * perBar + j
                return (
                  <Box flexDirection="column">
                    {beatThumb(b, i)}
                    <Box flexDirection="row">
                      <Text dimColor>
                        {b.beat}・{b.at.toFixed(1)}s{' '}
                      </Text>
                      <Button
                        key={`beat-${i}`}
                        label="✎"
                        onPress={() => update($, run, x => ({ ...x, openInput: openBeat === i ? null : { kind: 'beat' as const, index: i } }))}
                      />
                    </Box>
                  </Box>
                )
              })}
            </Box>
            {openBeat !== null && Math.floor(openBeat / perBar) === bi ? (
              <Input
                key={`beat-input-${openBeat}`}
                placeholder={`第 ${r.beats[openBeat]?.beat} 拍想怎麼改？例如「太空了，補一個元素」`}
                submitLabel="改這拍"
                autoFocus
                onSubmit={async value => {
                  const b = r.beats[openBeat]
                  if (!b || !value.trim()) return
                  await update($, run, x => ({ ...x, openInput: null }))
                  await ask(`改第 ${b.beat} 拍（${b.at.toFixed(1)} 秒）：${value.trim()}；只改這一拍，其他拍不動`)
                }}
              />
            ) : null}
          </Box>
        ))}
      </Box>
    )
    const step3 = generate ? step3Generate : (
      <Box flexDirection="column" gap={1}>
        {head(
          2,
          '分鏡板',
          hasBoard
            ? `${join(r.out ?? '', 'storyboard.json')}・${r.scenes.length} 幕 ${Math.round(total)} 秒${r.isFraming ? '・產生縮圖中…' : ''}`
            : '',
        )}
        {hasBoard && !linked && r.script.length > 0 ? (
          <Box flexDirection="row" paddingLeft={3} gap={1}>
            <Text color="warning">
              腳本 {r.script.length} 句、分鏡 {r.scenes.length} 幕，對不上
            </Text>
            <Button
              key="rebuild"
              label="⟳ 照腳本重排分鏡"
              variant="primary"
              onPress={() => ask('照腳本重排：script.md 已在面板上修改，依目前的 script.md 重排分鏡表（一句一幕）')}
            />
          </Box>
        ) : null}
        {r.scenes.map(card)}
        {r.lint
          .filter(w => w.row === null)
          .map((w, n) => (
            <Text key={`lint-all-${n}`} color="warning" wrap="wrap">
              {'   '}⚠ {w.message}
            </Text>
          ))}
      </Box>
    )

    // ④ 合成影片：確認分鏡板後才算
    const canCompose = hasBoard && !r.isPicking && !r.isConceptPicking && (r.renderedAt === null || r.isEdited)
    const step4 = (
      <Box flexDirection="column">
        {head(
          3,
          '合成影片',
          done[3]
            ? `${join(r.out ?? '', 'demo.mp4')}${r.renderSeconds ? `・${r.renderSeconds} 秒` : ''} → 結果頁已打開`
            : canCompose
              ? generate
                ? '逐拍看過後按「合成影片」（約 1.5 分鐘）'
                : '確認分鏡板後按「合成影片」'
              : '',
        )}
        {canCompose ? (
          <Box paddingLeft={3}>
            <Button
              key="compose"
              label="▶ 合成影片"
              variant="primary"
              onPress={() =>
                ask(
                  generate
                    ? '合成影片：逐拍分鏡板確認好了，照目前的 reel.html 算圖'
                    : `合成影片：分鏡板確認好了，照目前的 storyboard.json、用風格 ${styleArg(r)} 算圖`,
                )
              }
            />
          </Box>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {pickStep}
        {scriptStep}
        {step3}
        {step4}
        {r.framesNote ? <Text color="warning" wrap="wrap">⚠ {r.framesNote}</Text> : null}
        {r.note ? <Text dimColor>⚠ {r.note}</Text> : null}
      </Box>
    )
  })
}
