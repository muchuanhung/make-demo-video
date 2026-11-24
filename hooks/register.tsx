// make-demo-video 的四步進度面板：跟著 ① 腳本 → ② 風格 → ③ 分鏡 → ④ 算圖 前進。
// - ② 由 Claude 呼叫 show_options 展開：風格縮圖、比例、秒數、幕數，按「確定」把選擇當成下一則訊息送出。
// - ③ 列出分鏡，可上移、刪除（直接改 storyboard.json 與 script.md），按「重新算圖」才重算。
// 進度從 Claude 的工具呼叫認出來（寫了 script.md、storyboard.json，跑了 render.mjs），不靠 Claude 回報。
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Aspect, Choice, Run, SceneRow } from '../types'

const PLUGIN = 'make-demo-video'
const PANE = 'make-demo-video'
const TOOL_NAME = 'show_options'
const TOOL = `mcp__${PLUGIN}__${TOOL_NAME}`
const SECONDS = [15, 30, 45, 60]
const MIN_SCENES = 3
const MAX_SCENES = 8
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
}

// 欄位改了就換 shape，舊版存下的值會被丟掉，不會讀到形狀不對的資料。
const run = atom({ plugin: 'make-demo-video', key: 'run' } as const, FRESH, { shape: 'run-3' })

/** thumb：PNG 縮圖路徑（終端機用 Image 畫）；svg：VS Code、桌面版等畫面用的縮圖（它們沒有 Image，但有 Svg）。 */
type StyleInfo = { id: string; name: string; swatch: string[]; thumb: string | null; svg: string | null }

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 風格縮圖的 SVG：先用風格的顏色畫一張向量版（小標、重點色名稱、副標，和 PNG 縮圖同一個構圖），
 * 再把 PNG 縮圖疊在上面。畫面不讓 SVG 內嵌圖片時，至少還看得到向量版。
 */
function thumbSvg(style: { id: string; name: string; colors: Record<string, string>; fonts?: Record<string, string> }, pngBase64: string | null) {
  const c = style.colors
  const font = xml((style.fonts?.display ?? 'sans-serif').replace(/"/g, ''))
  const name = xml(style.name)
  const chip = Math.min(140, 30 + style.name.length * 22)
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" width="160" height="90">',
    `<rect width="160" height="90" rx="6" fill="${xml(c.backdrop ?? c.bg ?? '#000')}"/>`,
    `<text x="80" y="27" text-anchor="middle" font-family="${font}" font-size="7" letter-spacing="1" fill="${xml(c.accentInk ?? c.accent ?? '#888')}">${xml(style.id.toUpperCase())}</text>`,
    `<rect x="${80 - chip / 2}" y="33" width="${chip}" height="24" rx="4" fill="${xml(c.accent ?? '#888')}"/>`,
    `<text x="80" y="50.5" text-anchor="middle" font-family="${font}" font-size="16" font-weight="700" fill="${xml(c.accentText ?? c.text ?? '#fff')}">${name}</text>`,
    `<text x="80" y="71" text-anchor="middle" font-family="${font}" font-size="7" fill="${xml(c.muted ?? c.text ?? '#888')}">demo 影片</text>`,
    pngBase64 ? `<image href="data:image/png;base64,${pngBase64}" width="160" height="90" preserveAspectRatio="xMidYMid slice"/>` : '',
    '</svg>',
  ].join('')
}
let styles: StyleInfo[] = []

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

function toRows(board: { scenes?: unknown }): SceneRow[] {
  const scenes = Array.isArray(board.scenes) ? board.scenes : []
  return scenes.map(raw => {
    const s = (raw ?? {}) as Record<string, unknown>
    const items = Array.isArray(s.items) ? s.items.map(plain).join('、') : ''
    return {
      kind: String(s.kind ?? '?'),
      seconds: Number(s.seconds) || 0,
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
        fonts?: Record<string, string>
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
        svg: thumbSvg({ ...style, name: style.name ?? style.id }, png),
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

/** 從輸出資料夾重讀 script.md 與 storyboard.json；讀不到就保留目前內容，並把原因記在 note。 */
async function refresh($: $Like) {
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
  if (stat && stat.mtimeMs >= r.startedAt) {
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

/** 檔案所在的資料夾；只有檔名、看不出資料夾時回傳 null（沿用目前的輸出資料夾）。 */
const dirOf = (path: string): string | null => (path.includes('/') ? path.replace(/\/[^/]*$/, '') || '/' : null)

async function start($: $Like) {
  const now = await $.clock.now()
  await update($, run, () => ({ ...FRESH, isActive: true, startedAt: now }))
  await $.ui.open({ id: PANE, title: 'make-demo-video' })
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
  await update($, run, x => ({ ...x, isEdited: true }))
  await refresh($)
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
const remove = (i: number) => <T,>(list: T[]) => list.filter((_, j) => j !== i)

function styleLabel(id: string) {
  if (id === CUSTOM) return '從素材定義風格'
  const s = styles.find(x => x.id === id)
  return s ? `${s.name}（${s.id}）` : id
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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
    for (const w of writesIn(e)) {
      if (w.path.endsWith('script.md')) {
        const script = parseScript(w.content)
        await update($, run, x => ({ ...x, out: dirOf(w.path) ?? x.out, script: script.length ? script : x.script }))
      } else if (w.path.endsWith('storyboard.json')) {
        try {
          const scenes = toRows(JSON.parse(w.content) as { scenes?: unknown })
          await update($, run, x => ({ ...x, out: dirOf(w.path) ?? x.out, scenes, isScriptEdited: false }))
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
      const now = await $.clock.now()
      await update($, run, x => ({
        ...x,
        renderedAt: took ? now : x.renderedAt,
        renderSeconds: took ? Number(took[1]) : x.renderSeconds,
        isEdited: took ? false : x.isEdited,
        isChosen: x.isChosen || Boolean(style),
        choice: style && !x.isChosen ? { ...x.choice, style: (style[1] ?? '').replace(/^.*\/|\.json$/g, '') } : x.choice,
      }))
    }
    await refresh($)
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
        {head(0, '腳本', done[0] ? `${join(r.out ?? '', 'script.md')}・${r.script.length} 句` : '讀素材中…')}
        {r.script.map((line, i) => (
          <Box flexDirection="row" paddingLeft={3}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">
                {String(i + 1).padStart(2)}. {line}
              </Text>
            </Box>
            {r.out && i > 0 ? <Button key={`line-up-${i}`} label="↑" onPress={() => editScript($, moveUp(i))} /> : <Text>   </Text>}
            {r.out && r.script.length > 1 ? (
              <Button key={`line-del-${i}`} label="✕" onPress={() => editScript($, remove(i))} />
            ) : null}
          </Box>
        ))}
        {r.out && done[0] ? (
          <Box paddingLeft={3}>
            <Input
              key="line-add"
              placeholder="新增一句（20 字以內）…"
              submitLabel="加入"
              onSubmit={value => (value.trim() ? editScript($, list => [...list, value]) : undefined)}
            />
          </Box>
        ) : null}
        {r.isScriptEdited && r.scenes.length > 0 ? (
          <Box paddingLeft={3}>
            <Button
              key="rebuild"
              label="⟳ 照腳本重排分鏡"
              variant="primary"
              onPress={() =>
                $.prompt.submit({
                  text: '照腳本重排：script.md 已在面板上修改，依目前的 script.md 重排分鏡表（一句一幕）並重新算圖',
                })
              }
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
      await update($, run, y => ({ ...y, isChosen: true, isPicking: false }))
      await $.prompt.submit({
        text: `② 選好了：風格 ${styleLabel(x.choice.style)}、比例 ${x.choice.aspect}、約 ${x.choice.seconds} 秒、${x.choice.scenes} 幕`,
      })
    }
    const step2 = (
      <Box flexDirection="column">
        {head(
          1,
          '風格',
          done[1] || r.isChosen
            ? `${styleLabel(c.style)}・${c.aspect}・${c.seconds} 秒・${c.scenes} 幕`
            : pick
              ? '請選擇，按「確定」'
              : '',
        )}
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

    // ③ 分鏡：上移、刪除、重新算圖
    const total = r.scenes.reduce((sum, s) => sum + s.seconds, 0)
    const step3 = (
      <Box flexDirection="column">
        {head(2, '分鏡', done[2] ? `${join(r.out ?? '', 'storyboard.json')}・${r.scenes.length} 幕 ${Math.round(total)} 秒` : '')}
        {r.scenes.map((s, i) => (
          <Box flexDirection="row" paddingLeft={3}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">
                {String(i + 1).padStart(2)} <Text dimColor>{s.kind.padEnd(8)}</Text> {String(s.seconds).padStart(3)}s {s.label}
              </Text>
            </Box>
            {i > 0 ? <Button key={`up-${i}`} label="↑" onPress={() => editScenes($, moveUp(i))} /> : <Text>   </Text>}
            {r.scenes.length > 2 ? <Button key={`del-${i}`} label="✕" onPress={() => editScenes($, remove(i))} /> : null}
          </Box>
        ))}
        {r.isEdited ? (
          <Box paddingLeft={3}>
            <Button
              key="rerender"
              label="⟳ 重新算圖"
              variant="primary"
              onPress={() =>
                $.prompt.submit({ text: '重新算圖：分鏡表已在面板上修改，照目前的 storyboard.json 重跑算圖指令' })
              }
            />
          </Box>
        ) : null}
      </Box>
    )

    // ④ 算圖
    const step4 = head(
      3,
      '算圖',
      done[3]
        ? `${join(r.out ?? '', 'demo.mp4')}${r.renderSeconds ? `・${r.renderSeconds} 秒` : ''} → 結果頁已打開`
        : r.isEdited
          ? '分鏡改過了，按「重新算圖」'
          : '',
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
