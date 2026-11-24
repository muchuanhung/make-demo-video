import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 面板走完一次 /make-demo-video：① 讀到 script.md、② 在面板上選、③ 刪一幕、④ 算圖完成。
// 檔案系統用記憶體裡的假資料代替，hook 在這裡代表 engine。

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
    return { value: f.text }
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
  return { files, put, now: () => clock }
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

test('面板跟著四步前進：選設定、刪一幕、重新算圖', async ($, on) => {
  const fs = fakeFs(on)
  const submitted: string[] = []
  on('clock.now', () => ({ value: fs.now() }))
  on('command.register', () => ({ value: { command: 'demo-panel' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__make-demo-video__show_options' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text ?? '')
    return { text: e.text ?? '' }
  })
  on('tool.call', () => ({ result: { stdout: '算圖中 100%\n完成，花了 13.2 秒（影片 12 秒）' } }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: '/make-demo-video 把這個 repo 做成 demo 影片', wait: false, origin: { kind: 'composer' } })

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /讀素材中/ }))?.text).toContain('讀素材中')

  // ① Claude 寫了 script.md
  fs.put('docs/demo/script.md', '1. 台灣天氣，一頁看完\n2. 選縣市\n3. 三個重點\n4. 打開就能用\n')
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/script.md', content: '…' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /script\.md・4 句/ }))?.text).toContain('4 句')

  // ② Claude 呼叫 show_options，使用者在面板上改成霓虹、9:16、45 秒、3 幕再按確定
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', suggested: ['neon', 'nope'], scenes: 4 })
  await ui.redraw()
  await ui.press({ key: 'aspect-9:16' })
  await ui.press({ key: 'sec-45' })
  await ui.press({ key: 'scenes-down' })
  await ui.press({ key: 'confirm' })
  expect(submitted.at(-1)).toBe('② 選好了：風格 霓虹（neon）、比例 9:16、約 45 秒、3 幕')

  // ③ Claude 寫了 storyboard.json；使用者刪掉第 2 幕
  fs.put('docs/demo/storyboard.json', JSON.stringify(BOARD))
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/storyboard.json', content: '…' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /4 幕 15 秒/ }))?.text).toContain('storyboard.json')
  await ui.press({ key: 'del-1' })
  const board = JSON.parse(fs.files.get('docs/demo/storyboard.json')!.text)
  expect(board.scenes.map((s: { kind: string }) => s.kind)).toEqual(['title', 'points', 'outro'])
  expect(fs.files.get('docs/demo/script.md')!.text).toBe('1. 台灣天氣，一頁看完\n2. 三個重點\n3. 打開就能用\n')

  // 上移第 3 幕（outro）到第 2 幕
  await ui.redraw()
  await ui.press({ key: 'up-2' })
  const moved = JSON.parse(fs.files.get('docs/demo/storyboard.json')!.text)
  expect(moved.scenes.map((s: { kind: string }) => s.kind)).toEqual(['title', 'outro', 'points'])

  await ui.redraw()
  await ui.press({ key: 'rerender' })
  expect(submitted.at(-1)).toContain('重新算圖')

  // ④ 算圖完成
  await $.tool.call({ tool: 'Bash', command: 'node render.mjs --storyboard docs/demo/storyboard.json --style neon --out docs/demo' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /demo\.mp4・13\.2 秒/ }))?.text).toContain('結果頁已打開')
  await ui.unmount()
})

test('沒在跑 /make-demo-video 時，其他工具呼叫不受影響、面板只顯示提示', async ($, on) => {
  fakeFs(on)
  on('tool.call', () => ({ result: { stdout: 'ok' } }))
  const ran = await $.tool.call({ tool: 'Bash', command: 'cat docs/demo/script.md' })
  expect(ran.result).toEqual({ stdout: 'ok' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /輸入 \/make-demo-video 開始/ }))?.text).toContain('開始')
  await ui.unmount()
})

test('終端機上 ② 顯示風格縮圖，沒有縮圖的風格只畫色票', async ($, on) => {
  const fs = fakeFs(on)
  fs.put('STYLES/thumbs/studio.png', 'png')
  on('clock.now', () => ({ value: fs.now() }))
  on('command.register', () => ({ value: { command: 'demo-panel' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__make-demo-video__show_options' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text ?? '' }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '/make-demo-video', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', suggested: ['studio'] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const thumb = await ui.find({ type: 'Image' })
  expect(thumb?.props.alt).toBe('暖白解說')
  expect(await ui.find({ type: 'Button', key: 'style-neon' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'style-custom' })).toBeTruthy()
  await ui.unmount()
})

test('Bash 一次寫出 script.md 和 storyboard.json、讀檔又失敗時，面板仍從指令內容顯示，並註明讀不到的原因', async ($, on) => {
  const fs = fakeFs(on, /demo-syntax/)
  on('clock.now', () => ({ value: fs.now() }))
  on('command.register', () => ({ value: { command: 'demo-panel' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__make-demo-video__show_options' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text ?? '' }))
  on('tool.call', () => ({ result: { stdout: '' } }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: '/make-demo-video https://syntax.sammics.cc', wait: false, origin: { kind: 'composer' } })
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
  on('clock.now', () => ({ value: fs.now() }))
  on('command.register', () => ({ value: { command: 'demo-panel' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__make-demo-video__show_options' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text ?? '' }))
  on('tool.call', () => ({ result: { stdout: '完成，花了 11.7 秒' } }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: '/make-demo-video', wait: false, origin: { kind: 'composer' } })
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
