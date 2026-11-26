import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// 面板走完一次 /make-demo-video：① 在面板上選剪法與設定、② 腳本、③ 分鏡板（縮圖、上下移、刪除、插一句、重畫）、④ 合成影片。
// 檔案系統與指令執行用記憶體裡的假資料代替，hook 在這裡代表 engine。

const STYLES: Record<string, object> = {
  studio: { id: 'studio', name: '暖白解說', colors: { bg: '#fcfaf7', surface: '#fff', text: '#2b2726', accent: '#e2694a' } },
  neon: { id: 'neon', name: '霓虹', colors: { bg: '#120b1f', surface: '#1c1230', text: '#f5eaff', accent: '#ff3ea5' } },
}

const CUTS: Record<string, object> = {
  'fast-tour': { id: 'fast-tour', name: '快節奏導覽', suits: '有網站可截圖的產品', defaults: { aspect: '16:9', seconds: 15 } },
  'pain-point': { id: 'pain-point', name: '痛點解法', suits: '先講問題再秀解法', defaults: { aspect: '9:16', seconds: 30 } },
  signature: { id: 'signature', name: '招牌片', mode: 'generate', suits: '發表會開場', defaults: { aspect: '9:16', seconds: 15 } },
}

/** failReads：路徑符合時讀取失敗，模擬實機上讀不到檔案。 */
function fakeFs(on: On, failReads?: RegExp) {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let clock = 1_000
  const put = (path: string, text: string) => files.set(path, { text, mtimeMs: (clock += 10) })
  for (const [id, style] of Object.entries(STYLES)) {
    put(`STYLES/${id}.json`, JSON.stringify(style))
  }
  for (const [id, meta] of Object.entries(CUTS)) {
    put(`CUTS/${id}/meta.json`, JSON.stringify(meta))
  }
  // 外掛自帶的風格檔、剪法包在 $.plugin.root 底下，測試裡不管 root 是哪裡都對到 STYLES/、CUTS/
  // 相對路徑會被解析成工作目錄底下的絕對路徑，一樣只看 docs/demo/ 之後
  const key = (path: string) =>
    path
      .replace(/^.*\/skills\/make-demo-video\/styles/, 'STYLES')
      .replace(/^.*\/skills\/make-demo-video\/cuts/, 'CUTS')
      .replace(/^.*\/(docs\/demo\/)/, '$1')
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
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of files.keys()) {
      if (!p.startsWith(dir + '/')) continue
      const [name, ...rest] = p.slice(dir.length + 1).split('/')
      names.set(name ?? '', rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  return { files, put, key, now: () => clock }
}

/**
 * engine 的其餘部分：送出的訊息記在 submitted，跑過的指令記在 runs。
 * frames.mjs 被呼叫時，照當下的分鏡表幕數「產生」縮圖檔；framesExit 不是 0 時模擬失敗。
 */
function engine(on: On, fs: ReturnType<typeof fakeFs>, opts: { toolStdout?: string; framesExit?: number; framesStderr?: string; lint?: object[] } = {}) {
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
  // shell 的 cd 會留到下一個指令：session 的工作目錄跟著變
  let cwd = '/repo'
  on('session.cwd', () => ({ value: cwd }))
  // 專案根目錄：shell 的 cd 不會動它
  on('session.root', () => ({ value: '/repo' }))
  on('tool.call', (_, e) => {
    const cd = String((e as { command?: string }).command ?? '').match(/^cd\s+(\S+)\s*&&/)?.[1]
    if (cd) cwd = cd.startsWith('/') ? cd : `${cwd}/${cd}`
    return { result: { stdout: opts.toolStdout ?? '' } }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const exitCode = opts.framesExit ?? 0
    if (exitCode === 0 && argv.some(a => a.endsWith('frames.mjs'))) {
      const board = fs.files.get(fs.key(argv[argv.indexOf('--storyboard') + 1] ?? ''))
      const out = fs.key(argv[argv.indexOf('--out') + 1] ?? '')
      const count = board ? (JSON.parse(board.text) as { scenes: unknown[] }).scenes.length : 0
      for (let n = 1; n <= count; n++) fs.put(`${out}/scene-${n}.png`, `frame-${n}`)
      if (opts.lint) fs.put(`${out}/lint.json`, JSON.stringify(opts.lint))
    }
    return {
      value: { exitCode, stdout: '', stderr: exitCode ? opts.framesStderr ?? 'Error: 找不到風格「nope」' : '', isStdoutTruncated: false, isStderrTruncated: false },
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

test('面板跟著四步前進：先選剪法與設定、再寫腳本、分鏡板改順序與刪除、確認後才合成影片', async ($, on) => {
  const fs = fakeFs(on)
  const { submitted, runs } = engine(on, fs, { toolStdout: '算圖中 100%\n完成，花了 13.2 秒（影片 12 秒）' })
  await begin($)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /讀素材中/ }))?.text).toContain('讀素材中')

  // ① Claude 讀完素材呼叫 show_options：推薦剪法與理由；使用者改成 9:16、45 秒、3 幕再按確定
  await $.tool.call({
    tool: 'mcp__make-demo-video__show_options',
    out: 'docs/demo',
    cuts: ['fast-tour', 'nope'],
    reason: '天氣網站截圖完整，適合捲動導覽',
    scenes: 4,
  })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /截圖完整/ }))?.text).toContain('天氣網站')
  expect((await ui.find({ type: 'Text', text: /^推薦$/ }))?.text).toBe('推薦')
  expect(await ui.find({ type: 'Button', key: 'cut-pain-point' })).toBeTruthy()
  // 外觀一律從素材取色，面板不提供內建色票
  expect(await ui.find({ type: 'Button', key: 'style-neon' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'look-palette' })).toBeFalsy()
  await ui.press({ key: 'aspect-9:16' })
  await ui.press({ key: 'sec-45' })
  await ui.press({ key: 'scenes-down' })
  await ui.press({ key: 'confirm' })
  expect(submitted.at(-1)).toBe('① 選好了：剪法 快節奏導覽（fast-tour）、比例 9:16、約 45 秒、3 幕')

  // ② Claude 照剪法寫了 script.md：分鏡板出現前，腳本可以逐句改
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /照剪法 快節奏導覽/ }))?.text).toContain('寫腳本中')
  fs.put('docs/demo/script.md', SCRIPT)
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/script.md', content: SCRIPT })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /script\.md・4 句/ }))?.text).toContain('4 句')
  expect(await ui.find({ type: 'Button', key: 'line-del-1' })).toBeTruthy()

  // ③ Claude 寫了 storyboard.json：面板跑 frames.mjs 產生縮圖，① 收成一行，卡片顯示腳本句子
  fs.put('docs/demo/storyboard.json', JSON.stringify(BOARD))
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/storyboard.json', content: JSON.stringify(BOARD) })
  const frames = runs.at(-1)!
  expect(frames[1]).toMatch(/skills\/make-demo-video\/scripts\/frames\.mjs$/)
  expect(frames.slice(2)).toEqual(['--storyboard', '/repo/docs/demo/storyboard.json', '--style', '/repo/docs/demo/style.json', '--out', '/repo/docs/demo/frames'])
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

test('終端機上 ① 剪法卡用 Image 畫縮圖；沒有縮圖的剪法只有按鈕', async ($, on) => {
  const fs = fakeFs(on)
  fs.put('CUTS/fast-tour/thumb.png', 'cut-png')
  engine(on, fs)
  await begin($, 'terminal')
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', cuts: ['fast-tour'] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const alts = (await ui.findAll({ type: 'Image' })).map(found => found.props.alt)
  expect(alts).toEqual(['快節奏導覽'])
  expect(await ui.find({ type: 'Button', key: 'cut-fast-tour' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'cut-pain-point' })).toBeTruthy()
  await ui.unmount()
})

test('VS Code 聊天面板沒有 Image：① 剪法卡改用 SVG 包住 PNG 縮圖', async ($, on) => {
  const fs = fakeFs(on)
  fs.put('CUTS/fast-tour/thumb.png', 'png-bytes')
  engine(on, fs)
  await begin($, 'vscode')
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', cuts: ['fast-tour'] })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.length).toBe(1)
  expect(svgs[0]?.props.alt).toBe('快節奏導覽')
  expect(svgs[0]?.props.source).toContain('data:image/png;base64,' + btoa('png-bytes'))
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

/** 走到分鏡板：① 選快節奏導覽、16:9 30 秒 4 幕，Claude 寫好腳本與分鏡表。 */
async function toBoard($: Engine, fs: ReturnType<typeof fakeFs>, ui: { redraw: () => Promise<void>; press: (target: { key: string }) => Promise<unknown> }) {
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', cuts: ['fast-tour'], scenes: 4, seconds: 30 })
  await ui.redraw()
  await ui.press({ key: 'confirm' })
  await writeBoth($, fs)
  await ui.redraw()
}

test('① 重新選：改了比例、秒數或幕數，請 Claude 照新設定重排', async ($, on) => {
  const fs = fakeFs(on)
  const { submitted } = engine(on, fs)
  await begin($)
  const ui = await $.ui.mount(PANE)
  await toBoard($, fs, ui)
  await ui.press({ key: 'repick' })
  await ui.redraw()
  await ui.press({ key: 'aspect-9:16' })
  await ui.press({ key: 'sec-15' })
  await ui.press({ key: 'confirm' })
  expect(submitted.at(-1)).toBe(
    '① 改選：剪法 快節奏導覽（fast-tour）、比例 9:16、約 15 秒、4 幕（原本 16:9、約 30 秒、4 幕）；照新設定重排分鏡表',
  )
  await ui.unmount()
})

test('① 重新選：換了剪法，請 Claude 照新剪法重寫腳本與分鏡表（剪法決定腳本怎麼寫）', async ($, on) => {
  const fs = fakeFs(on)
  const { submitted } = engine(on, fs)
  await begin($)
  const ui = await $.ui.mount(PANE)
  await toBoard($, fs, ui)
  await ui.press({ key: 'repick' })
  await ui.redraw()
  await ui.press({ key: 'cut-pain-point' })
  await ui.press({ key: 'confirm' })
  expect(submitted.at(-1)).toBe(
    '① 改選：剪法 痛點解法（pain-point）、比例 16:9、約 30 秒、4 幕（原本剪法 快節奏導覽（fast-tour））；照新剪法重寫 script.md 與分鏡表',
  )
  await ui.unmount()
})

test('① 沒給秒數與比例時用剪法的預設', async ($, on) => {
  const fs = fakeFs(on)
  const { submitted } = engine(on, fs)
  await begin($)
  const ui = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', cuts: ['pain-point'], scenes: 5 })
  await ui.redraw()
  await ui.press({ key: 'confirm' })
  expect(submitted.at(-1)).toBe('① 選好了：剪法 痛點解法（pain-point）、比例 9:16、約 30 秒、5 幕')
  await ui.unmount()
})

test('分鏡卡改字：直接寫回腳本與字幕（title 改 heading、其他改 caption），不經過 Claude', async ($, on) => {
  const fs = fakeFs(on)
  const { submitted, runs } = engine(on, fs)
  await begin($)
  await writeBoth($, fs)
  const ui = await $.ui.mount(PANE)
  const asked = submitted.length
  const ran = runs.length

  await ui.press({ key: 'edit-1' })
  const field = await ui.find({ type: 'Input', key: 'edit-input-1' })
  expect(field?.props.value).toBe('選縣市')
  await ui.input({ key: 'edit-input-1', text: ' 選縣市，馬上看到天氣 ', kind: 'submit' })
  await ui.redraw()
  await ui.press({ key: 'edit-0' })
  await ui.input({ key: 'edit-input-0', text: '台灣天氣一頁看完', kind: 'submit' })

  const board = JSON.parse(fs.files.get('docs/demo/storyboard.json')!.text) as { scenes: Record<string, string>[] }
  expect(board.scenes[1]?.caption).toBe('選縣市，馬上看到天氣')
  expect(board.scenes[0]?.heading).toBe('台灣天氣一頁看完')
  expect(fs.files.get('docs/demo/script.md')!.text).toBe('1. 台灣天氣一頁看完\n2. 選縣市，馬上看到天氣\n3. 三個重點\n4. 打開就能用\n')
  expect(submitted.length).toBe(asked)
  expect(runs.length).toBe(ran + 2)
  await ui.unmount()
})

test('分鏡卡改字：phone／card 幕的字在 heading（大標題），有 caption 時才改 caption', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs)
  await begin($)
  const board = {
    title: 't',
    aspect: '16:9',
    scenes: [
      { kind: 'phone', seconds: 2, heading: '洪睦筌', image: 'home.jpg' },
      { kind: 'card', seconds: 1, heading: 'Weather Board' },
      { kind: 'phone', seconds: 2, heading: '舊標題', caption: '字幕', image: 'home.jpg' },
    ],
  }
  await writeBoth($, fs, board, '1. 洪睦筌\n2. Weather Board\n3. 字幕\n')
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'edit-0' })
  await ui.input({ key: 'edit-input-0', text: '把想法做成真的', kind: 'submit' })
  await ui.redraw()
  await ui.press({ key: 'edit-1' })
  await ui.input({ key: 'edit-input-1', text: '曉行 Dawnline', kind: 'submit' })
  await ui.redraw()
  await ui.press({ key: 'edit-2' })
  await ui.input({ key: 'edit-input-2', text: '新字幕', kind: 'submit' })

  const saved = JSON.parse(fs.files.get('docs/demo/storyboard.json')!.text) as { scenes: Record<string, string>[] }
  expect(saved.scenes[0]?.heading).toBe('把想法做成真的')
  expect(saved.scenes[0]?.caption).toBe(undefined)
  expect(saved.scenes[1]?.heading).toBe('曉行 Dawnline')
  expect(saved.scenes[2]?.heading).toBe('舊標題')
  expect(saved.scenes[2]?.caption).toBe('新字幕')
  await ui.unmount()
})

test('Claude 用別的風格算圖時（例如使用者在對話裡說換風格），面板跟著換，縮圖也重算', async ($, on) => {
  const fs = fakeFs(on)
  const { runs } = engine(on, fs, { toolStdout: '完成，花了 9 秒' })
  await begin($)
  const ui = await $.ui.mount(PANE)
  await toBoard($, fs, ui)

  await $.tool.call({ tool: 'Bash', command: 'node render.mjs --storyboard docs/demo/storyboard.json --style studio --out docs/demo' })
  expect(runs.at(-1)![runs.at(-1)!.indexOf('--style') + 1]).toBe('studio')
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /暖白解說（studio）/ }))?.text).toBeTruthy()

  await $.tool.call({ tool: 'Bash', command: 'node render.mjs --storyboard docs/demo/storyboard.json --style docs/demo/style.json --out docs/demo' })
  expect(runs.at(-1)![runs.at(-1)!.indexOf('--style') + 1]).toBe('/repo/docs/demo/style.json')
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /從素材定義風格/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('鏡頭模板：分鏡卡顯示模板中文名稱、照拍數換算秒數；改字寫回 heading；自動檢查的提醒顯示在對應的卡上', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs, {
    lint: [
      { row: 1, message: '第 2 幕：標題完整出現後只停 0.30 秒，至少要 0.5 秒' },
      { row: null, message: '平均一個鏡頭 1.8 秒，太慢' },
    ],
  })
  await begin($)
  const board = {
    title: 't',
    aspect: '9:16',
    beat: 0.4,
    scenes: [
      { shot: 'hook', heading: '把想法\n做成真的。' },
      { shot: 'card', beats: 2, heading: '曉行 Dawnline' },
      { shot: 'outro', heading: '洪睦筌' },
      { shot: 'stat', value: '1,534', heading: '個地點' },
    ],
  }
  await writeBoth($, fs, board, '1. 把想法做成真的。\n2. 曉行 Dawnline\n3. 洪睦筌\n4. 個地點\n')
  const ui = await $.ui.mount(PANE)
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /開場標語/ }))?.text).toContain('1 ・ 開場標語')
  const seconds = (await ui.findAll({ type: 'Text', text: /^\s*[\d.]+s\s*$/ })).map(found => found.text.trim())
  expect(seconds).toEqual(['1.2s', '0.8s', '2s', '1.6s'])
  expect((await ui.find({ type: 'Text', text: /只停 0\.30 秒/ }))?.text).toContain('⚠')
  expect((await ui.find({ type: 'Text', text: /平均一個鏡頭/ }))?.text).toContain('1.8 秒')

  await ui.press({ key: 'edit-1' })
  await ui.input({ key: 'edit-input-1', text: 'Weather Board', kind: 'submit' })
  const saved = JSON.parse(fs.files.get('docs/demo/storyboard.json')!.text) as { scenes: Record<string, string>[] }
  expect(saved.scenes[1]?.heading).toBe('Weather Board')
  expect(saved.scenes[1]?.caption).toBe(undefined)
  await ui.unmount()
})

test('操作示範的鏡頭：分鏡卡顯示中文名稱、照 0.5 秒一拍換算秒數；沒有 heading 的卡（字是網頁上的字）不能改字', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs)
  await begin($)
  const board = {
    title: 't',
    aspect: '16:9',
    beat: 0.5,
    scenes: [
      { shot: 'home', image: 'h.png', heading: 'Taiwan weather,' },
      { shot: 'click', image: 'h.png', to: '切換城市' },
      { shot: 'burst', images: [{ image: 'a.png' }, { image: 'b.png' }] },
      { shot: 'dock', heading: 'weather-board' },
    ],
  }
  await writeBoth($, fs, board, '1. Taiwan weather,\n2. 點「切換城市」\n3. 重拍\n4. weather-board\n')
  const ui = await $.ui.mount(PANE)
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /・ 現場/ }))?.text).toContain('1 ・ 現場')
  expect((await ui.find({ type: 'Text', text: /・ 點/ }))?.text).toContain('2 ・ 點')
  const seconds = (await ui.findAll({ type: 'Text', text: /^\s*[\d.]+s\s*$/ })).map(found => found.text.trim())
  expect(seconds).toEqual(['3s', '2.5s', '1.5s', '6s'])
  // 有腳本時卡上是腳本那一句（操作路徑「點「切換城市」」）
  expect((await ui.find({ type: 'Text', text: /^點「切換城市」$/ }))?.text).toBe('點「切換城市」')
  expect(await ui.find({ type: 'Button', key: 'edit-0' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'edit-1' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'redo-1' })).toBeTruthy()
  await ui.unmount()
})

test('幕數上限跟 SKILL.md 一致（12 幕）：腳本 9 句時不會被壓成 8 幕，最多加到 12', async ($, on) => {
  const fs = fakeFs(on)
  const { submitted } = engine(on, fs)
  await begin($)
  const ui = await $.ui.mount(PANE)
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', cuts: ['fast-tour'], scenes: 9 })
  await ui.redraw()
  // 預設是腳本的 9 句；再加 6 次會停在上限 12
  for (let n = 0; n < 6; n++) await ui.press({ key: 'scenes-up' })
  await ui.press({ key: 'confirm' })
  expect(submitted.at(-1)).toContain('12 幕')
  await ui.unmount()
})

test('沿用輸出資料夾裡既有的分鏡表（沒有寫檔）：Claude 跑 check.mjs 檢查它之後，分鏡板讀進來並產生縮圖', async ($, on) => {
  const fs = fakeFs(on)
  const { runs } = engine(on, fs)
  // 上一次留下的腳本與分鏡表，修改時間早於這次開始
  fs.put('docs/demo/script.md', SCRIPT)
  fs.put('docs/demo/storyboard.json', JSON.stringify(BOARD))
  fs.put('elsewhere.txt', '') // 讓時鐘往前走：這次開始的時間晚於舊檔
  await begin($, 'vscode')
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', cuts: ['fast-tour'], scenes: 4 })
  const frameRuns = () => runs.filter(argv => argv.some(a => a.endsWith('frames.mjs'))).length

  // 還沒到 ③：舊的分鏡表不當成這次的分鏡板
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(frameRuns()).toBe(0)
  expect(await ui.find({ type: 'Text', text: /storyboard\.json・4 幕/ })).toBeFalsy()

  // 檢查別的資料夾的分鏡表（例如範例）不算沿用
  await $.tool.call({ tool: 'Bash', command: 'node /x/skills/make-demo-video/scripts/check.mjs --storyboard examples/a/storyboard.json' })
  expect(frameRuns()).toBe(0)

  // ③ Claude 決定沿用、只跑自動檢查（絕對路徑也要對得上 docs/demo）
  await $.tool.call({ tool: 'Bash', command: 'node /x/skills/make-demo-video/scripts/check.mjs --storyboard /repo/docs/demo/storyboard.json' })
  expect(frameRuns()).toBe(1)
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /storyboard\.json・4 幕/ }))?.text).toContain('4 幕')
  const svgs = (await ui.findAll({ type: 'Svg' })).filter(found => String(found.props.alt).startsWith('第'))
  expect(svgs.length).toBe(4)

  // 分鏡表沒變時再檢查一次，不重算縮圖
  await $.tool.call({ tool: 'Bash', command: 'node /x/skills/make-demo-video/scripts/check.mjs --storyboard /repo/docs/demo/storyboard.json' })
  expect(frameRuns()).toBe(1)
  await ui.unmount()
})

test('寫完分鏡表接著跑 check.mjs：縮圖只算一次', async ($, on) => {
  const fs = fakeFs(on)
  const { runs } = engine(on, fs)
  await begin($)
  await writeBoth($, fs)
  await $.tool.call({ tool: 'Bash', command: 'node skills/make-demo-video/scripts/check.mjs --storyboard docs/demo/storyboard.json' })
  expect(runs.filter(argv => argv.some(a => a.endsWith('frames.mjs'))).length).toBe(1)
})

test('VS Code 分鏡縮圖：有小 JPEG 就用 JPEG；縮圖太多時總量不超過面板輸出上限，超過的不畫', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs)
  await begin($, 'vscode')
  await writeBoth($, fs)
  fs.put('docs/demo/frames/scene-1.jpg', 'small-1')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const first = (await ui.findAll({ type: 'Svg' })).find(found => found.props.alt === '第 1 幕')
  expect(first?.props.source).toContain('data:image/jpeg;base64,' + btoa('small-1'))
  await ui.unmount()

  // 12 幕、每張 30KB：base64 後全部放進去會超過 256KB
  const board = { ...BOARD, scenes: Array.from({ length: 12 }, (_, i) => ({ kind: 'title', seconds: 1, heading: `第${i + 1}句` })) }
  const script = board.scenes.map((x, i) => `${i + 1}. ${x.heading}`).join('\n') + '\n'
  await writeBoth($, fs, board, script)
  for (let n = 1; n <= 12; n++) fs.put(`docs/demo/frames/scene-${n}.jpg`, 'x'.repeat(30_000))
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/storyboard.json', content: JSON.stringify(board) })
  for (let n = 1; n <= 12; n++) fs.put(`docs/demo/frames/scene-${n}.jpg`, 'x'.repeat(30_000))
  const big = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const svgs = (await big.findAll({ type: 'Svg' })).filter(found => String(found.props.alt).startsWith('第'))
  const total = svgs.reduce((sum, found) => sum + String(found.props.source).length, 0)
  expect(svgs.length).toBeGreaterThan(0)
  expect(svgs.length).toBeLessThan(12)
  expect(total).toBeLessThan(200_000)
  await big.unmount()
})

const BEATS = {
  concept: '一條腰帶，繞成旅程',
  beat: 0.5,
  duration: 3,
  beats: Array.from({ length: 6 }, (_, k) => ({ beat: k + 1, at: k * 0.5, file: `beats/b0${k}.png`, thumb: `beats/b0${k}.jpg` })),
  problems: [],
}

test('招牌片（生成式剪法）：① 不問幕數 → ③ 在面板挑概念 → 逐拍分鏡板改一拍 → ④ 合成影片、結果頁', async ($, on) => {
  const fs = fakeFs(on)
  const { submitted, runs } = engine(on, fs, { toolStdout: '算圖中 100%\n完成，花了 92.4 秒（影片 15 秒、60fps、每格 3 個子格）\n結果頁 docs/demo/demo.html' })
  await begin($, 'vscode')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', cuts: ['signature'], reason: '品牌片', scenes: 7 })
  await ui.redraw()
  expect(await ui.find({ type: 'Button', key: 'scenes-up' })).toBeFalsy()
  await ui.press({ key: 'confirm' })
  expect(submitted.at(-1)).toBe('① 選好了：剪法 招牌片（signature）、比例 9:16、約 15 秒')

  fs.put('docs/demo/script.md', SCRIPT)
  await $.tool.call({ tool: 'Write', file_path: 'docs/demo/script.md', content: SCRIPT })

  // ③ 概念：Claude 呼叫 show_concepts，面板列出概念，使用者按第 2 個
  const concepts = ['太陽滴成雨珠', '一條線連起城市', '溫度計長成地圖']
  await $.tool.call({ tool: 'mcp__make-demo-video__show_concepts', out: 'docs/demo', concepts })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /一條線連起城市/ }))?.text).toContain('一條線連起城市')
  expect(await ui.find({ type: 'Button', key: 'compose' })).toBeFalsy()
  await ui.press({ key: 'concept-1' })
  expect(submitted.at(-1)).toBe('③ 概念選好了：一條線連起城市')

  // Claude 寫好 reel.html、跑 signature.mjs beats：面板讀 beats.json 畫逐拍分鏡板（一小節一排），不跑 frames.mjs
  fs.put('docs/demo/beats/beats.json', JSON.stringify(BEATS))
  for (let k = 0; k < 6; k++) fs.put(`docs/demo/beats/b0${k}.jpg`, `beat-${k}`)
  await $.tool.call({ tool: 'Bash', command: 'cd /repo && node skills/make-demo-video/scripts/signature.mjs beats docs/demo/reel.html' })
  expect(runs.some(argv => argv.some(a => a.endsWith('frames.mjs')))).toBe(false)
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /6 拍・檢查通過/ }))?.text).toContain('reel.html')
  expect((await ui.find({ type: 'Text', text: /第 2 小節/ }))?.text).toBe('第 2 小節')
  const beat = (await ui.findAll({ type: 'Svg' })).find(found => found.props.alt === '第 5 拍')
  expect(beat?.props.source).toContain('data:image/jpeg;base64,' + btoa('beat-4'))

  await ui.press({ key: 'beat-4' })
  await ui.input({ key: 'beat-input-4', text: '太空了，補一個元素', kind: 'submit' })
  expect(submitted.at(-1)).toBe('改第 5 拍（2.0 秒）：太空了，補一個元素；只改這一拍，其他拍不動')

  // ④ 合成：照 reel.html 算圖；算完 ④ 打勾，之後又改了 reel.html 就要再合成
  await ui.redraw()
  await ui.press({ key: 'compose' })
  expect(submitted.at(-1)).toBe('合成影片：逐拍分鏡板確認好了，照目前的 reel.html 算圖')
  await $.tool.call({ tool: 'Bash', command: 'node skills/make-demo-video/scripts/signature.mjs render docs/demo/reel.html' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /demo\.mp4・92\.4 秒/ }))?.text).toContain('結果頁已打開')
  expect(await ui.find({ type: 'Button', key: 'compose' })).toBeFalsy()
  await $.tool.call({ tool: 'Edit', file_path: 'docs/demo/reel.html', old_string: 'a', new_string: 'b' })
  await ui.redraw()
  expect(await ui.find({ type: 'Button', key: 'compose' })).toBeTruthy()
  await ui.unmount()
})

test('Claude 中途 cd 進剪法資料夾讀 cut.md 之後才呼叫 show_concepts：out 照專案根目錄解析，逐拍分鏡板照樣出現', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs)
  await begin($, 'vscode')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', cuts: ['signature'], reason: '品牌片', scenes: 7 })
  await ui.press({ key: 'confirm' })
  fs.put('docs/demo/script.md', SCRIPT)
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/demo/script.md', content: SCRIPT })

  // 讀剪法規則：cd 留在剪法資料夾
  await $.tool.call({ tool: 'Bash', command: 'cd /repo/skills/make-demo-video/cuts/signature && cat cut.md' })
  await $.tool.call({ tool: 'mcp__make-demo-video__show_concepts', out: 'docs/demo', concepts: ['太陽滴成雨珠', '一條線連起城市'] })
  await ui.press({ key: 'concept-0' })

  fs.put('docs/demo/beats/beats.json', JSON.stringify(BEATS))
  await $.tool.call({ tool: 'Bash', command: 'cd /repo && node skills/make-demo-video/scripts/signature.mjs beats docs/demo/reel.html' })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /6 拍・檢查通過/ }))?.text).toContain('/repo/docs/demo/reel.html')
  expect(await ui.find({ type: 'Button', key: 'beat-0' })).toBeTruthy()
  await ui.unmount()
})

test('show_concepts 少於兩個概念時拒絕，Claude 會看到原因', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs)
  await begin($)
  const one = await $.tool.call({ tool: 'mcp__make-demo-video__show_concepts', concepts: ['只有一個'] })
  expect(one).toMatchObject({ isError: true, text: expect.stringContaining('至少要給兩個概念') })
})

test('分鏡卡秒數 − ＋：模板幕一次一拍、其他幕一次 0.5 秒，直接改分鏡表、總長跟著變、縮圖重算，到上下限就不顯示', async ($, on) => {
  const fs = fakeFs(on)
  const { runs } = engine(on, fs)
  await begin($)
  const board = {
    title: 't',
    aspect: '16:9',
    beat: 0.4,
    scenes: [
      { shot: 'feature', image: 'a.png', heading: '功能' },
      { shot: 'card', beats: 1, heading: '作品' },
      { kind: 'title', seconds: 3, heading: '標題' },
    ],
  }
  await writeBoth($, fs, board, '1. 功能\n2. 作品\n3. 標題\n')
  const ui = await $.ui.mount(PANE)
  const saved = () => (JSON.parse(fs.files.get('docs/demo/storyboard.json')!.text) as { scenes: Record<string, unknown>[] }).scenes
  expect((await ui.find({ type: 'Text', text: /3 幕 5 秒/ }))?.text).toContain('storyboard.json')

  // 功能標註預設 5 拍（2s）：＋ 一次加一拍；超過 3 秒也能加（自動檢查會提醒），到 12 拍 ＋ 消失
  const before = runs.length
  await ui.press({ key: 'longer-0' })
  expect(saved()[0]?.beats).toBe(6)
  expect(runs.length).toBe(before + 1)
  await ui.redraw()
  await ui.press({ key: 'longer-0' })
  expect(saved()[0]?.beats).toBe(7)
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /3 幕 6 秒/ }))?.text).toContain('3 幕 6 秒')
  for (let n = 8; n <= 12; n++) {
    await ui.press({ key: 'longer-0' })
    await ui.redraw()
  }
  expect(saved()[0]?.beats).toBe(12)
  expect(await ui.find({ type: 'Button', key: 'longer-0' })).toBeFalsy()

  // 作品卡 1 拍：已經最短，沒有 −
  expect(await ui.find({ type: 'Button', key: 'shorter-1' })).toBeFalsy()

  // 不是模板的幕：一次 0.5 秒；其他幕不動
  await ui.press({ key: 'shorter-2' })
  expect(saved()[2]?.seconds).toBe(2.5)
  expect(saved()[1]?.beats).toBe(1)
  await ui.unmount()
})

test('Claude 中途 cd 進輸出資料夾（cd 會留著）、之後用相對路徑寫檔與 sed 改拍數：面板照樣讀得到分鏡表、產生縮圖與提醒', async ($, on) => {
  const fs = fakeFs(on)
  const { runs } = engine(on, fs, { lint: [{ row: null, message: '平均一個鏡頭 2.8 秒，太慢' }] })
  await begin($, 'vscode')
  await $.tool.call({ tool: 'mcp__make-demo-video__show_options', out: 'docs/demo', cuts: ['fast-tour'], scenes: 4 })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'confirm' })

  // 第一個指令 cd 進去，之後的指令都在 docs/demo 裡跑，路徑只寫檔名
  fs.put('docs/demo/script.md', SCRIPT)
  await $.tool.call({ tool: 'Bash', command: `cd docs/demo && cat > script.md <<'EOF'\n${SCRIPT}EOF` })
  fs.put('docs/demo/storyboard.json', JSON.stringify(BOARD))
  await $.tool.call({ tool: 'Bash', command: `cat > storyboard.json <<'EOF'\n${JSON.stringify(BOARD)}\nEOF\nnode /x/check.mjs --storyboard storyboard.json` })
  const frames = runs.filter(argv => argv.some(a => a.endsWith('frames.mjs')))
  expect(frames.at(-1)?.slice(2)).toEqual(['--storyboard', '/repo/docs/demo/storyboard.json', '--style', '/repo/docs/demo/style.json', '--out', '/repo/docs/demo/frames'])

  // sed 改檔面板認不出內容，但重讀時要讀得到（之前的 bug：相對路徑被解析成 docs/demo/docs/demo/…）
  const edited = { ...BOARD, scenes: BOARD.scenes.map(x => ({ ...x, seconds: 2 })) }
  fs.put('docs/demo/storyboard.json', JSON.stringify(edited))
  await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/x/y/' storyboard.json && node /x/check.mjs --storyboard storyboard.json" })
  await ui.redraw()
  expect((await ui.find({ type: 'Text', text: /4 幕 8 秒/ }))?.text).toContain('/repo/docs/demo/storyboard.json')
  expect((await ui.find({ type: 'Text', text: /平均一個鏡頭/ }))?.text).toContain('2.8 秒')
  const svgs = (await ui.findAll({ type: 'Svg' })).filter(found => String(found.props.alt).startsWith('第'))
  expect(svgs.length).toBe(4)
  await ui.unmount()
})

test('縮圖產生失敗的原因不會被下一個工具呼叫清掉', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs, { framesExit: 1 })
  await begin($)
  await writeBoth($, fs)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /分鏡縮圖產生失敗/ }))?.text).toContain('找不到風格')
  await ui.unmount()
})

test('連按秒數 ＋：每一下都算到（不會兩下讀到同一份舊分鏡表），縮圖重算不會比按的次數多', async ($, on) => {
  const fs = fakeFs(on)
  const { runs } = engine(on, fs)
  await begin($)
  const board = { ...BOARD, beat: 0.4, scenes: [{ shot: 'feature', image: 'a.png', heading: '功能' }, { shot: 'outro', heading: '收尾' }] }
  await writeBoth($, fs, board, '1. 功能\n2. 收尾\n')
  const ui = await $.ui.mount(PANE)
  const frameRuns = () => runs.filter(argv => argv.some(a => a.endsWith('frames.mjs'))).length
  const before = frameRuns()
  await Promise.all([ui.press({ key: 'longer-0' }), ui.press({ key: 'longer-0' }), ui.press({ key: 'longer-0' })])
  expect((JSON.parse(fs.files.get('docs/demo/storyboard.json')!.text) as { scenes: { beats?: number }[] }).scenes[0]?.beats).toBe(8)
  // 測試裡的縮圖程式瞬間跑完、不會重疊，這裡只確認重算次數不超過按的次數；重疊時的合併靠 regenFrames 的排隊
  expect(frameRuns() - before).toBeLessThanOrEqual(3)
  await ui.unmount()
})

test('縮圖程式當掉時，面板顯示真正的錯誤，不是最後一行的 Node.js 版本', async ($, on) => {
  const fs = fakeFs(on)
  engine(on, fs, {
    framesExit: 1,
    framesStderr: '<anonymous_script>:1\n\n\nSyntaxError: Unexpected end of JSON input\n    at JSON.parse (<anonymous>)\n\nNode.js v24.21.0\n',
  })
  await begin($)
  await writeBoth($, fs)
  const ui = await $.ui.mount(PANE)
  const text = (await ui.find({ type: 'Text', text: /分鏡縮圖產生失敗/ }))?.text ?? ''
  expect(text).toContain('SyntaxError: Unexpected end of JSON input')
  expect(text).not.toContain('Node.js')
  await ui.unmount()
})
