import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// 面板走完一次 /make-demo-video：① 腳本、② 在面板上選、③ 分鏡板（縮圖、上下移、刪除、插一句、重畫）、④ 合成影片。
// 檔案系統與指令執行用記憶體裡的假資料代替，hook 在這裡代表 engine。

const STYLES: Record<string, object> = {
  studio: { id: 'studio', name: '暖白解說', colors: { bg: '#fcfaf7', surface: '#fff', text: '#2b2726', accent: '#e2694a' } },
  neon: { id: 'neon', name: '霓虹', colors: { bg: '#120b1f', surface: '#1c1230', text: '#f5eaff', accent: '#ff3ea5' } },
}

/** failReads：路徑符合時讀取失敗，模擬實機上讀不到檔案。 */
function fakeFs(on: On, failReads?: RegExp) {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let clock = 1_000
  const put = (path: string, text: string) => files.set(path, { text, mtimeMs: (clock += 10) })
  for (const [id, style] of Object.entries(STYLES)) {
    put(`STYLES/${id}.json`, JSON.stringify(style))
  }
  // 外掛自帶的風格檔在 $.plugin.root 底下，測試裡不管 root 是哪裡都對到 STYLES/
  // 相對路徑會被解析成工作目錄底下的絕對路徑，一樣只看 docs/demo/ 之後
  const key = (path: string) =>
    path.replace(/^.*\/skills\/make-demo-video\/styles/, 'STYLES').replace(/^.*\/(docs\/demo\/)/, '$1')
  on('fs.read', (_, e) => {
    if (failReads?.test(e.path)) throw new Error('EACCES ' + e.path)
    const f = files.get(key(e.path))
    if (!f) throw new Error('ENOENT ' + e.path)
    return { value: e.as === 'bytes' ? { base64: btoa(f.text) } : f.text }
  })
  on('fs.write', (_, e) => {
    put(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files.has(key(e.path)) }))
  on('fs.stat', (_, e) => {
    const f = files.get(key(e.path))
    if (!f) throw new Error('ENOENT ' + e.path)
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.list', (_, e) => {
    const dir = key(e.path)
    return {
      value: [...files.keys()]
        .filter(p => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/'))
        .map(p => ({ name: p.slice(dir.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  return { files, put, key, now: () => clock }
}

/**
 * engine 的其餘部分：送出的訊息記在 submitted，跑過的指令記在 runs。
 * frames.mjs 被呼叫時，照當下的分鏡表幕數「產生」縮圖檔；framesExit 不是 0 時模擬失敗。
 */
function engine(on: On, fs: ReturnType<typeof fakeFs>, opts: { toolStdout?: string; framesExit?: number } = {}) {
  const submitted: string[] = []
  const runs: string[][] = []
  on('clock.now', () => ({ value: fs.now() }))
  on('command.register', () => ({ value: { command: 'demo-panel' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__make-demo-video__show_options' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text ?? '')
    return { text: e.text ?? '' }
  })
  on('tool.call', () => ({ result: { stdout: opts.toolStdout ?? '' } }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const exitCode = opts.framesExit ?? 0
    if (exitCode === 0 && argv.some(a => a.endsWith('frames.mjs'))) {
      const board = fs.files.get(fs.key(argv[argv.indexOf('--storyboard') + 1] ?? ''))
      const out = fs.key(argv[argv.indexOf('--out') + 1] ?? '')
      const count = board ? (JSON.parse(board.text) as { scenes: unknown[] }).scenes.length : 0
      for (let n = 1; n <= count; n++) fs.put(`${out}/scene-${n}.png`, `frame-${n}`)
    }
    return {
      value: { exitCode, stdout: '', stderr: exitCode ? 'Error: 找不到風格「nope」' : '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  return { submitted, runs }
}

const PANE = {
  plugin: 'make-demo-video',
  component: 'Pane',
  requestId: 'make-demo-video',
  surface: 'desktop',
  props: { title: 'make-demo-video', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BOARD = {
  title: 't',
  aspect: '16:9',
  scenes: [
    { kind: 'title', seconds: 3, heading: '台灣天氣，**一頁看完**' },
    { kind: 'browser', seconds: 5, caption: '選縣市' },
    { kind: 'points', seconds: 4, items: ['甲', '乙'] },
    { kind: 'outro', seconds: 3, heading: '打開就能用' },
  ],
}
const SCRIPT = '1. 台灣天氣，一頁看完\n2. 選縣市\n3. 三個重點\n4. 打開就能用\n'

async function begin($: Engine, surface: 'desktop' | 'terminal' | 'vscode' = 'desktop') {
  await $.session.start({ cwd: '/repo', surface, isInteractive: true })
  await $.prompt.submit({ text: '/make-demo-video 把這個 repo 做成 demo 影片', wait: false, origin: { kind: 'composer' } })
}

/** Claude 寫出腳本與分鏡表（Write 工具），面板會跟著重算縮圖。 */
async function writeBoth($: Engine, fs: ReturnType<typeof fakeFs>, board: object = BOARD, script = SCRIPT) {
  fs.put('docs/demo/script.md', script)
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/script.md', content: script })
  fs.put('docs/demo/storyboard.json', JSON.stringify(board))
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/storyboard.json', content: JSON.stringify(board) })
}

const kinds = (fs: ReturnType<typeof fakeFs>) =>
  (JSON.parse(fs.files.get('docs/demo/storyboard.json')!.text) as { scenes: { kind: string }[] }).scenes.map(s => s.kind)

test('面板跟著四步前進：選設定、分鏡板改順序與刪除、確認後才合成影片', async ($, on) => {
  const fs = fakeFs(on)
  const { submitted, runs } = engine(on, fs, { toolStdout: '算圖中 100%\n完成，花了 13.2 秒（影片 12 秒）' })
  await begin($)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /讀素材中/ }))?.text).toContain('讀素材中')

  // ① Claude 寫了 script.md：分鏡板出現前，腳本可以逐句改
  fs.put('docs/demo/script.md', SCRIPT)
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/script.md', content: SCRIPT })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /script\.md・4 句/ }))?.text).toContain('4 句')
  expect(await ui.find({ type: 'Button', key: 'line-del-1' })).toBeTruthy()

  // ② Claude 呼叫 show_options，使用者改成霓虹、9:16、45 秒、3 幕再按確定
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', suggested: ['neon', 'nope'], scenes: 4 })
  await ui.redraw()
  await ui.press({ key: 'aspect-9:16' })
  await ui.press({ key: 'sec-45' })
  await ui.press({ key: 'scenes-down' })
  await ui.press({ key: 'confirm' })
  expect(submitted.at(-1)).toBe('② 選好了：風格 霓虹（neon）、比例 9:16、約 45 秒、3 幕')

  // ③ Claude 寫了 storyboard.json：面板跑 frames.mjs 產生縮圖，① 收成一行，卡片顯示腳本句子
  fs.put('docs/demo/storyboard.json', JSON.stringify(BOARD))
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/storyboard.json', content: JSON.stringify(BOARD) })
  const frames = runs.at(-1)!
  expect(frames[1]).toMatch(/skills\/make-demo-video\/scripts\/frames\.mjs$/)
  expect(frames.slice(2)).toEqual(['--storyboard', 'docs/demo/storyboard.json', '--style', 'neon', '--out', 'docs/demo/frames'])
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /4 幕 15 秒/ }))?.text).toContain('storyboard.json')
  expect((await ui.find({ type: 'Text', text: /在下方分鏡板編輯/ }))?.text).toContain('4 句')
  expect(await ui.find({ type: 'Button', key: 'line-del-1' })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /^三個重點$/ }))?.text).toBe('三個重點')
  expect(await ui.find({ type: 'Button', key: 'compose' })).toBeTruthy()

  // 刪掉第 2 幕：分鏡表與腳本一起改，縮圖重算
  const before = runs.length
  await ui.press({ key: 'del-1' })
  expect(kinds(fs)).toEqual(['title', 'points', 'outro'])
  expect(fs.files.get('docs/demo/script.md')!.text).toBe('1. 台灣天氣，一頁看完\n2. 三個重點\n3. 打開就能用\n')
  expect(runs.length).toBe(before + 1)

  // 上移第 3 幕、下移第 1 幕
  await ui.redraw()
  await ui.press({ key: 'up-2' })
  expect(kinds(fs)).toEqual(['title', 'outro', 'points'])
  await ui.redraw()
  await ui.press({ key: 'down-0' })
  expect(kinds(fs)).toEqual(['outro', 'title', 'points'])
  expect(await ui.find({ type: 'Button', key: 'down-2' })).toBeFalsy()

  // ④ 按合成影片 → Claude 算圖 → 完成
  await ui.redraw()
  await ui.press({ key: 'compose' })
  expect(submitted.at(-1)).toMatch(/^合成影片：/)
  await $.tool.call({ tool: 'Bash', command: 'node render.mjs --storyboard docs/demo/storyboard.json --style neon --out docs/demo' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /demo\.mp4・13\.2 秒/ }))?.text).toContain('結果頁已打開')
  expect(await ui.find({ type: 'Button', key: 'compose' })).toBeFalsy()

  // 合成之後 Claude 又改了分鏡表（例如重畫一幕）：要再合成一次
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/storyboard.json', content: JSON.stringify(BOARD) })
  await ui.redraw()
  expect(await ui.find({ type: 'Button', key: 'compose' })).toBeTruthy()
  await ui.unmount()
})

test('分鏡卡：插一句、重畫一幕都交給 Claude，只改那一幕', async ($, on) => {
  const fs = fakeFs(on)
  const { submitted } = engine(on, fs)
  await begin($)
  await writeBoth($, fs)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'insert-1' })
  await ui.input({ key: 'insert-input-1', text: '  搜尋任何城市 ', kind: 'submit' })
  expect(fs.files.get('docs/demo/script.md')!.text).toBe('1. 台灣天氣，一頁看完\n2. 選縣市\n3. 搜尋任何城市\n4. 三個重點\n5. 打開就能用\n')
  expect(submitted.at(-1)).toBe('插入一幕：在第 2 幕後面插入一句「搜尋任何城市」（script.md 已更新）；只為這句補一幕，其他幕不動')

  // 腳本 5 句、分鏡還是 4 幕：提示對不上，可以照腳本重排
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /對不上/ }))?.text).toContain('腳本 5 句、分鏡 4 幕')
  expect(await ui.find({ type: 'Button', key: 'rebuild' })).toBeTruthy()

  await ui.press({ key: 'redo-0' })
  await ui.input({ key: 'redo-input-0', text: '推近到標題', kind: 'submit' })
  expect(submitted.at(-1)).toBe('重畫第 1 幕：推近到標題；只改這一幕，腳本的字不變')
  await ui.redraw()
  await ui.press({ key: 'redo-2' })
  await ui.input({ key: 'redo-input-2', text: '', kind: 'submit' })
  expect(submitted.at(-1)).toBe('重畫第 3 幕：換一個呈現方式；只改這一幕，腳本的字不變')
  await ui.unmount()
})

test('分鏡卡縮圖：終端機用 Image（絕對路徑、generation），VS Code 用 SVG 包 PNG', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs)
  await begin($, 'terminal')
  await writeBoth($, fs)

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const images = (await term.findAll({ type: 'Image' })).filter(found => String(found.props.alt).startsWith('第'))
  expect(images.length).toBe(4)
  expect(images[0]?.props.source).toMatchObject({ file: '/repo/docs/demo/frames/scene-1.png', format: 'png' })
  expect(typeof (images[0]?.props.source as { generation?: number }).generation).toBe('number')
  await term.unmount()

  const code = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const svgs = (await code.findAll({ type: 'Svg' })).filter(found => String(found.props.alt).startsWith('第'))
  expect(svgs.length).toBe(4)
  expect(svgs[1]?.props.source).toContain('data:image/png;base64,' + btoa('frame-2'))
  await code.unmount()
})

test('縮圖產生失敗時不擋流程，面板註明原因', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs, { framesExit: 1 })
  await begin($)
  await writeBoth($, fs)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /分鏡縮圖產生失敗/ }))?.text).toContain('找不到風格')
  expect(await ui.find({ type: 'Button', key: 'compose' })).toBeTruthy()
  await ui.unmount()
})

test('沒在跑 /make-demo-video 時，其他工具呼叫不受影響、面板只顯示提示', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs, { toolStdout: 'ok' })
  const ran = await $.tool.call({ tool: 'Bash', command: 'cat docs/demo/script.md' })
  expect(ran.result).toEqual({ stdout: 'ok' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /輸入 \/make-demo-video 開始/ }))?.text).toContain('開始')
  await ui.unmount()
})

test('終端機上 ② 顯示風格縮圖，沒有縮圖的風格只畫色票', async ($, on) => {
  const fs = fakeFs(on)
  fs.put('STYLES/thumbs/studio.png', 'png')
  engine(on, fs)
  await begin($, 'terminal')
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', suggested: ['studio'] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const thumb = await ui.find({ type: 'Image' })
  expect(thumb?.props.alt).toBe('暖白解說')
  expect(await ui.find({ type: 'Button', key: 'style-neon' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'style-custom' })).toBeTruthy()
  await ui.unmount()
})

test('VS Code 聊天面板沒有 Image：② 改用 SVG 包住 PNG 縮圖，沒有 PNG 的風格只畫色票', async ($, on) => {
  const fs = fakeFs(on)
  fs.put('STYLES/thumbs/studio.png', 'png-bytes')
  engine(on, fs)
  await begin($, 'vscode')
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', suggested: ['studio'] })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  // 只有 studio 有 PNG，所以只有一張 SVG；霓虹沒有縮圖，只剩色票與按鈕
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.length).toBe(1)
  expect(svgs[0]?.props.alt).toBe('暖白解說')
  expect(svgs[0]?.props.source).toContain('data:image/png;base64,' + btoa('png-bytes'))
  expect(await ui.find({ type: 'Button', key: 'style-neon' })).toBeTruthy()
  await ui.unmount()
})

test('Bash 一次寫出 script.md 和 storyboard.json、讀檔又失敗時，面板仍從指令內容顯示，並註明讀不到的原因', async ($, on) => {
  const fs = fakeFs(on, /demo-syntax/)
  engine(on, fs)
  await begin($)
  // 檔案在磁碟上存在，但讀取失敗（模擬實機上讀不到的情況）
  fs.put('/abs/docs/demo-syntax/script.md', 'x')
  const command = [
    "cat > /abs/docs/demo-syntax/script.md <<'EOF'",
    '1. 練習寫程式，每次都留下足跡',
    '2. 按下分析，看你用了哪些語法',
    '3. Syntax Atlas，我的語法足跡',
    'EOF',
    "cat > /abs/docs/demo-syntax/storyboard.json <<'EOF'",
    JSON.stringify({ scenes: [{ kind: 'title', seconds: 4, heading: 'a' }, { kind: 'browser', seconds: 7, caption: 'b' }, { kind: 'outro', seconds: 4, heading: 'c' }] }),
    'EOF',
  ].join('\n')
  await $.tool.call({ tool: 'Bash', command })

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /script\.md・3 句/ }))?.text).toContain('/abs/docs/demo-syntax/script.md')
  expect((await ui.find({ type: 'Text', text: /3 幕 15 秒/ }))?.text).toContain('storyboard.json')
  expect((await ui.find({ type: 'Text', text: /讀不到/ }))?.text).toContain('demo-syntax/script.md')
  await ui.unmount()
})

test('先 cd 到輸出資料夾再寫檔、或只寫檔名時，輸出資料夾不會被當成檔名', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs, { toolStdout: '完成，花了 11.7 秒' })
  await begin($)
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/demo-kinutabi/script.md', content: '1. 甲\n2. 乙\n3. 丙\n' })
  const board = JSON.stringify({ scenes: [{ kind: 'title', seconds: 3, heading: '甲' }, { kind: 'outro', seconds: 3, heading: '丙' }] })
  await $.tool.call({ tool: 'Bash', command: `cd docs/demo-kinutabi && cat > storyboard.json <<'EOF'\n${board}\nEOF` })
  await $.tool.call({ tool: 'Bash', command: `cat > storyboard.json <<'EOF'\n${board}\nEOF` })
  await $.tool.call({ tool: 'Bash', command: 'node render.mjs --storyboard docs/demo-kinutabi/storyboard.json --style studio' })

  const ui = await $.ui.mount(PANE)
  // 之前的 bug：輸出資料夾被記成 storyboard.json，畫面出現 storyboard.json/script.md
  for (const [pattern, file] of [[/script\.md・3 句/, 'script.md'], [/2 幕 6 秒/, 'storyboard.json'], [/demo\.mp4/, 'demo.mp4']] as const) {
    const text = (await ui.find({ type: 'Text', text: pattern }))?.text ?? ''
    expect(text).toContain(`docs/demo-kinutabi/${file}`)
    expect(text).not.toContain('storyboard.json/')
  }
  await ui.unmount()
})

test('分鏡板出現前，① 腳本可以刪除、上移、下移、新增一句', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs)
  await begin($)
  fs.put('docs/demo/script.md', '1. 甲\n2. 乙\n3. 丙\n')
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/script.md', content: '1. 甲\n2. 乙\n3. 丙\n' })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'line-del-1' })
  expect(fs.files.get('docs/demo/script.md')!.text).toBe('1. 甲\n2. 丙\n')
  await ui.redraw()
  await ui.press({ key: 'line-up-1' })
  expect(fs.files.get('docs/demo/script.md')!.text).toBe('1. 丙\n2. 甲\n')
  await ui.redraw()
  expect(await ui.find({ type: 'Button', key: 'line-down-1' })).toBeFalsy()
  await ui.press({ key: 'line-down-0' })
  expect(fs.files.get('docs/demo/script.md')!.text).toBe('1. 甲\n2. 丙\n')
  await ui.redraw()
  await ui.input({ key: 'line-add', text: '  新的一句 ', kind: 'submit' })
  expect(fs.files.get('docs/demo/script.md')!.text).toBe('1. 甲\n2. 丙\n3. 新的一句\n')
  // 還沒有分鏡板，不需要「照腳本重排」
  await ui.redraw()
  expect(await ui.find({ type: 'Button', key: 'rebuild' })).toBeFalsy()
  await ui.unmount()
})
