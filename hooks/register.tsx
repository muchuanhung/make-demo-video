// make-demo-video 的四步進度面板：跟著 ① 腳本 → ② 風格 → ③ 分鏡板 → ④ 合成影片 前進。
// - ① 腳本在分鏡板出現前可以直接改；之後收成一行，改動都在分鏡卡上做。
// - ② 由 Claude 呼叫 show_options 展開：風格縮圖、比例、秒數、幕數，按「確定」把選擇當成下一則訊息送出。
//   選完可以按「重新選」：只換風格時面板自己重算縮圖；改了比例、秒數或幕數才請 Claude 重排。
// - ③ 分鏡板：每張卡是「一句腳本＋這一幕的縮圖」。↑ ↓ ✕ 直接改 storyboard.json 與 script.md；
//   ＋ 插一句、⟳ 重畫這一幕交給 Claude 只改那一幕。分鏡表一變，面板自己跑 frames.mjs 重算縮圖（約 1 秒）。
// - ④ 使用者確認分鏡板後按「合成影片」才算整支影片。
// 進度從 Claude 的工具呼叫認出來（寫了 script.md、storyboard.json，跑了 check.mjs、render.mjs），不靠 Claude 回報。
// 沿用上一次留下的分鏡表時 Claude 不會寫檔，所以跑 check.mjs 檢查它也算進到 ③。
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Aspect, Choice, LintNote, Run, SceneRow } from '../types'

const PLUGIN = 'make-demo-video'
const PANE = 'make-demo-video'
const TOOL_NAME = 'show_options'
const TOOL = `mcp__${PLUGIN}__${TOOL_NAME}`
const SECONDS = [12, 15, 30, 45, 60]
const MIN_SCENES = 3
const MAX_SCENES = 12 // 跟 SKILL.md 的幕數範圍（3–12）一致
const STYLE_ORDER = ['screenplay', 'studio', 'terminal', 'neon', 'blueprint']
const CUSTOM = 'custom'

const FRESH: Run = {
  isActive: false,
  startedAt: 0,
  out: null,
  script: [],
  isPicking: false,
  suggested: [],
  choice: { style: 'studio', aspect: '16:9', seconds: 30, scenes: 6 },
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
}

// 欄位改了就換 shape，舊版存下的值會被丟掉，不會讀到形狀不對的資料。
const run = atom({ plugin: 'make-demo-video', key: 'run' } as const, FRESH, { shape: 'run-6' })

/** thumb：PNG 縮圖路徑（終端機用 Image 畫）；svg：VS Code、桌面版等畫面用的縮圖（它們沒有 Image，但有 Svg）。 */
type StyleInfo = { id: string; name: string; swatch: string[]; thumb: string | null; svg: string | null }

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
/** session 的工作目錄（終端機的 Image 要絕對路徑）；session.start 時記下。 */
let cwd = ''
/** 分鏡縮圖包成的 SVG，以「檔案路徑＃framesAt」為鍵，縮圖重算後自然換成新的。 */
const frameSvgs = new Map<string, string>()

type $Like = EngineInterface

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)))
const nearestSeconds = (n: number) => SECONDS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best))
const join = (dir: string, name: string) => (dir === '' || dir === '.' ? name : `${dir.replace(/\/+$/, '')}/${name}`)
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
}

function toRows(board: { scenes?: unknown; beat?: unknown }): SceneRow[] {
  const scenes = Array.isArray(board.scenes) ? board.scenes : []
  const beat = Number(board.beat) || 0.4
  return scenes.map(raw => {
    const s = (raw ?? {}) as Record<string, unknown>
    const items = Array.isArray(s.items) ? s.items.map(plain).join('、') : ''
    const shot = typeof s.shot === 'string' ? s.shot : null
    // 用模板時秒數多半沒寫，照拍數換算
    const seconds = Number(s.seconds) || (shot ? (Number(s.beats) || SHOTS[shot]?.beats || 0) * beat : 0)
    return {
      kind: shot ? SHOTS[shot]?.label ?? shot : String(s.kind ?? '?'),
      seconds: Math.round(seconds * 10) / 10,
      label: plain(s.caption || s.heading || items || s.name || ''),
    }
  })
}

async function loadStyles($: $Like) {
  const dir = `${$.plugin.root}/skills/make-demo-video/styles`
  const found: StyleInfo[] = []
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const style = JSON.parse(await readText($, `${dir}/${entry.name}`)) as {
        id: string
        name?: string
        colors: Record<string, string>
      }
      const c = style.colors
      const thumbPath = `${dir}/thumbs/${style.id}.png`
      const thumb = (await $.fs.exists(thumbPath)) ? thumbPath : null
      // PNG 只在載入時讀一次；之後每次重畫都用同一段 SVG 文字
      const png = thumb
        ? await ($.fs.read(thumb, { as: 'bytes' }) as Promise<unknown>).then(
            v => (v as { base64?: string }).base64 ?? null,
            () => null,
          )
        : null
      found.push({
        id: style.id,
        name: style.name ?? style.id,
        swatch: [c.backdrop ?? c.bg, c.surface, c.text, c.accent].filter((x): x is string => Boolean(x)),
        thumb,
        svg: thumbSvg(png),
      })
    } catch {
      // 壞掉的風格檔不擋面板，算圖時 render.mjs 會指出錯在哪
    }
  }
  const rank = (id: string) => (STYLE_ORDER.includes(id) ? STYLE_ORDER.indexOf(id) : 99)
  styles = found.sort((a, b) => rank(a.id) - rank(b.id))
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
function checkedBoard(command: string): string | null {
  const m = command.match(/check\.mjs[^\n;&|]*?--storyboard\s+["']?([^\s"';&|]+)/)
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
async function regenFrames($: $Like) {
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
    if (!ok) note = `分鏡縮圖產生失敗：${res.stderr.trim().split('\n').at(-1) ?? res.exitCode}`
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
  await update($, run, x => ({ ...x, isFraming: false, framesAt: ok ? now : x.framesAt, lint: lint ?? x.lint, note: note ?? x.note }))
}

/** 這次還沒算過縮圖，或分鏡表在上次算縮圖之後又改過（例如用 sed 改、面板認不出來）。 */
async function framesStale($: $Like): Promise<boolean> {
  const r = await read($, run)
  if (!r.out) return false
  if (r.framesAt === null) return true
  const stat = await $.fs.stat(join(r.out, 'storyboard.json')).catch(() => null)
  return Boolean(stat && stat.mtimeMs > r.framesAt)
}

/** 第 n 幕縮圖的 SVG（VS Code 聊天面板等沒有 Image 的畫面用）。 */
async function frameSvg($: $Like, file: string, framesAt: number, portrait: boolean): Promise<string | null> {
  const key = `${file}#${framesAt}`
  const cached = frameSvgs.get(key)
  if (cached) return cached
  const base64 = await ($.fs.read(file, { as: 'bytes' }) as Promise<unknown>).then(
    v => (v as { base64?: string }).base64 ?? null,
    () => null,
  )
  if (!base64) return null
  const [w, h] = portrait ? [180, 320] : [320, 180]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image href="data:image/png;base64,${base64}" width="${w}" height="${h}"/></svg>`
  frameSvgs.set(key, svg)
  return svg
}

/** 改分鏡表；script.md 與分鏡一句一幕時，同一個動作也套到腳本上。 */
async function editScenes($: $Like, op: <T>(list: T[]) => T[]) {
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
  await regenFrames($)
}

/** 改第 i 句的字：寫回 script.md（一句一幕時）與這一幕的字幕（用鏡頭模板、title／outro 是 heading；phone／card 沒有 caption 時也是 heading；其他是 caption）。 */
async function editLine($: $Like, i: number, text: string) {
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
  await regenFrames($)
}

/** 改腳本（上移、刪除、新增一句），寫回 script.md；分鏡表要等使用者按「照腳本重排分鏡」才改。 */
async function editScript($: $Like, op: (list: string[]) => string[]) {
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = (e as unknown as { cwd?: string }).cwd ?? ''
    await loadStyles($)
    await $.command.register({ name: 'demo-panel', description: '打開 make-demo-video 的四步進度面板' })
    await $.tool.register({
      name: TOOL_NAME,
      description:
        'make-demo-video 的 ② 挑風格：在面板上顯示風格縮圖、比例（16:9／9:16）、秒數、幕數讓使用者選。' +
        '呼叫後輸出 ② 進度行並結束這一回合；使用者按「確定」後，下一則訊息會是「② 選好了：…」，照它繼續 ③。',
      inputSchema: {
        type: 'object',
        properties: {
          out: { type: 'string', description: '輸出資料夾，例如 docs/demo' },
          suggested: {
            type: 'array',
            items: { type: 'string' },
            description: '依素材推薦的內建風格 id，最多三個，第一個是預設選取',
          },
          scenes: { type: 'integer', description: '腳本句數，當幕數的預設值' },
          seconds: { type: 'integer', description: '建議的總秒數' },
        },
        required: ['out'],
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
      suggested?: unknown
      scenes?: unknown
      seconds?: unknown
    }
    const ids = new Set(styles.map(s => s.id))
    const suggested = (Array.isArray(args.suggested) ? args.suggested : []).map(String).filter(id => ids.has(id)).slice(0, 3)
    const r = await read($, run)
    if (!r.isActive) await start($)
    await update($, run, x => ({
      ...x,
      out: typeof args.out === 'string' && args.out ? args.out : x.out,
      suggested,
      isPicking: true,
      isChosen: false,
      choice: {
        ...x.choice,
        style: suggested[0] ?? x.choice.style,
        scenes: clamp(Number(args.scenes) || x.script.length || x.choice.scenes, MIN_SCENES, MAX_SCENES),
        seconds: nearestSeconds(Number(args.seconds) || x.choice.seconds),
      },
    }))
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'make-demo-video', focus: true })
    // 沒有畫面能放面板（例如 claude -p）時，交給 .catch 改用對話框問
    if (!opened.isPlaced) throw new Error('pane not placed')
    return {
      result:
        '選項已顯示在 make-demo-video 面板上。現在輸出 ② 進度行（例如「② 風格｜請在右側面板選擇風格、比例、秒數與幕數」），然後結束這一回合，不要再呼叫其他工具。' +
        '使用者按「確定」後，下一則訊息會是「② 選好了：…」。',
    } as never
  }).catch(() => ({ deny: 'make-demo-video 面板無法顯示選項：請改用 AskUserQuestion 問使用者（比例、秒數、幕數、風格）。' }))

  // 每個工具呼叫結束後：認出輸出資料夾、認出算圖完成，再重讀檔案。
  on('tool.call', async ($, e, next) => {
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
    for (const w of writesIn(e)) {
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
      if (m) await update($, run, x => ({ ...x, out: (m[1] ?? '').replace(/\/+$/, '') || '.' }))
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
    // Claude 跑 check.mjs 檢查輸出資料夾裡的分鏡表：就算這次沒寫過它（沿用上一次留下的），也當成這次的分鏡板
    let adopted = false
    const checked = e.tool === 'Bash' ? checkedBoard(command) : null
    if (checked) {
      const dir = dirOf(checked) ?? '.'
      const out = (await read($, run)).out
      const same = (a: string) => absolute(a.replace(/^\.\/+/, '')).replace(/\/+$/, '')
      if (!out) await update($, run, x => ({ ...x, out: dir }))
      adopted = !out || same(dir) === same(out)
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
    const r = await read($, run)
    const cols = Math.max(24, e.props.bodyColumns ?? 40)

    if (!r.isActive) {
      return (
        <Box flexDirection="column">
          <Text bold>make-demo-video</Text>
          <Text dimColor>輸入 /make-demo-video 開始；面板會跟著 ① 腳本 → ② 風格 → ③ 分鏡 → ④ 算圖 前進。</Text>
        </Box>
      )
    }

    const done = [
      r.script.length > 0,
      !r.isPicking && (r.isChosen || r.scenes.length > 0),
      r.scenes.length > 0,
      r.renderedAt !== null && !r.isEdited,
    ]
    const current = done.indexOf(false)
    const hasBoard = r.scenes.length > 0
    const setChoice = (patch: Partial<Choice>) => update($, run, x => ({ ...x, choice: { ...x.choice, ...patch } }))

    const head = (i: number, title: string, detail: string) => (
      <Text>
        <Text color={done[i] ? 'success' : i === current ? 'warning' : 'inactive'}>
          {done[i] ? '✔' : i === current ? '●' : '○'}
        </Text>{' '}
        <Text bold={i === current}>{i + 1}. {title}</Text> <Text dimColor>{detail}</Text>
      </Text>
    )

    // ① 腳本
    const step1 = (
      <Box flexDirection="column">
        {head(
          0,
          '腳本',
          done[0]
            ? `${join(r.out ?? '', 'script.md')}・${r.script.length} 句${hasBoard ? '（在下方分鏡板編輯）' : ''}`
            : '讀素材中…',
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
        {r.out && done[0] && !hasBoard ? (
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

    // ② 風格：縮圖、色票、比例、秒數、幕數
    const c = r.choice
    const pick = r.isPicking && !r.isChosen
    const cellCols = 14
    const perRow = Math.max(2, Math.min(6, Math.floor((cols - 3) / (cellCols + 1))))
    const options = [
      ...styles,
      { id: CUSTOM, name: '從素材定義', swatch: [] as string[], thumb: null, svg: null },
    ]
    const rows: (typeof options)[] = []
    for (let i = 0; i < options.length; i += perRow) rows.push(options.slice(i, i + perRow))
    const cell = (s: (typeof options)[number], i: number) => {
      const isOn = c.style === s.id
      return (
        <Box flexDirection="column" width={cellCols} marginRight={1}>
          {Image && s.thumb ? (
            <Image key={`thumb-${s.id}`} source={{ file: s.thumb, format: 'png' }} columns={cellCols} rows={4} alt={s.name} />
          ) : Svg && s.svg ? (
            <Svg source={s.svg} alt={s.name} width={112} height={63} />
          ) : (
            <Text dimColor>{s.id === CUSTOM ? '  取網站色彩' : ' '}</Text>
          )}
          <Text>
            {s.swatch.map(color => (
              <Text color={color}>██</Text>
            ))}
            {r.suggested.includes(s.id) ? <Text color="warning"> 推薦</Text> : null}
          </Text>
          <Button
            key={`style-${s.id}`}
            label={`${isOn ? '●' : '○'} ${i + 1} ${s.name}`}
            hotkey={String(i + 1)}
            variant={isOn ? 'primary' : 'secondary'}
            onPress={() => setChoice({ style: s.id })}
          />
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
      const summary = `風格 ${styleLabel(now.style)}、比例 ${now.aspect}、約 ${now.seconds} 秒、${now.scenes} 幕`
      if (!was || x.scenes.length === 0) {
        await $.prompt.submit({ text: `② 選好了：${summary}` })
        return
      }
      const replan = was.aspect !== now.aspect || was.seconds !== now.seconds || was.scenes !== now.scenes
      if (replan) {
        await $.prompt.submit({
          text: `② 改選：${summary}（原本 ${was.aspect}、約 ${was.seconds} 秒、${was.scenes} 幕）；照新設定重排分鏡表`,
        })
      } else if (was.style !== now.style) {
        // 只換風格：分鏡表不用動，面板自己用新風格重算縮圖；合成影片的訊息會帶上新風格
        await update($, run, y => ({ ...y, isEdited: y.renderedAt !== null ? true : y.isEdited }))
        await regenFrames($)
      }
    }
    const repick = () =>
      update($, run, x => ({ ...x, isPicking: true, isChosen: false, pickedFrom: x.choice, openInput: null }))
    const step2 = (
      <Box flexDirection="column">
        {head(
          1,
          '風格',
          done[1] || r.isChosen
            ? `${styleLabel(c.style)}・${c.aspect}・${c.seconds} 秒・${c.scenes} 幕`
            : pick
              ? r.pickedFrom
                ? '重新選，按「確定」'
                : '請選擇，按「確定」'
              : '',
        )}
        {r.isChosen && !pick ? (
          <Box paddingLeft={3}>
            <Button key="repick" label="↺ 重新選" onPress={repick} />
          </Box>
        ) : null}
        {pick ? (
          <Box flexDirection="column" paddingLeft={3}>
            {rows.map((row, ri) => (
              <Box flexDirection="row">{row.map((s, ci) => cell(s, ri * perRow + ci))}</Box>
            ))}
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
            <Box flexDirection="row">
              <Text>幕數 </Text>
              <Button key="scenes-down" label="−" onPress={() => setChoice({ scenes: clamp(c.scenes - 1, MIN_SCENES, MAX_SCENES) })} />
              <Text> {c.scenes} 幕 </Text>
              <Button key="scenes-up" label="+" onPress={() => setChoice({ scenes: clamp(c.scenes + 1, MIN_SCENES, MAX_SCENES) })} />
              {r.script.length > 0 && c.scenes !== r.script.length ? (
                <Text dimColor> （腳本 {r.script.length} 句，Claude 會調整成 {c.scenes} 句）</Text>
              ) : null}
            </Box>
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
    const svgs = Svg && !Image && r.framesAt ? await Promise.all(r.scenes.map((_, i) => frameSvg($, framePath(i), framesAt, portrait))) : []
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
              <Text dimColor>
                {i + 1} ・ {s.kind} ・ {s.seconds}s
              </Text>
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
                <Button
                  key={`edit-${i}`}
                  label="✎ 改字"
                  onPress={() => update($, run, x => ({ ...x, openInput: input?.kind === 'edit' ? null : { kind: 'edit' as const, index: i } }))}
                />
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
    const step3 = (
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
    const canCompose = hasBoard && !r.isPicking && (r.renderedAt === null || r.isEdited)
    const step4 = (
      <Box flexDirection="column">
        {head(
          3,
          '合成影片',
          done[3]
            ? `${join(r.out ?? '', 'demo.mp4')}${r.renderSeconds ? `・${r.renderSeconds} 秒` : ''} → 結果頁已打開`
            : canCompose
              ? '確認分鏡板後按「合成影片」'
              : '',
        )}
        {canCompose ? (
          <Box paddingLeft={3}>
            <Button
              key="compose"
              label="▶ 合成影片"
              variant="primary"
              onPress={() => ask(`合成影片：分鏡板確認好了，照目前的 storyboard.json、用風格 ${styleArg(r)} 算圖`)}
            />
          </Box>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {step1}
        {step2}
        {step3}
        {step4}
        {r.note ? <Text dimColor>⚠ {r.note}</Text> : null}
      </Box>
    )
  })
}
