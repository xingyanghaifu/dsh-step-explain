// Self-check for dsh-step-explain's pure explanation layer. No dependency, no browser:
//   node selftest.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The bundle is a browser factory; capture it and run it against a stub React.
let factory
const window = { __ModuleLoader__: { load: ({ id, factory: fn }) => (factory = fn) } }
new Function('window', readFileSync(new URL('./client.js', import.meta.url), 'utf8'))(window)
assert.equal(typeof factory, 'function', 'client.js did not register a factory')

const element = (type, props, ...children) => ({ type, props, children })
const React = {
  createElement: element,
  useState: (v) => [v, () => {}],
  useMemo: (fn) => fn(),
  // Effects never run here: the surfaces are checked with the model answer absent.
  useEffect: () => {},
}
const built = factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require("${id}")`)
})
const { explain, groupSteps, stepsOf, callOf, rootOf, detailPayload, pickDetail, zh, en } = built.__test

/** Translate against one dictionary, with `{name}` interpolation like the platform. */
const translate = (dict) => (key, params) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match))
const t = translate(zh)

// --- explain ---------------------------------------------------------
const read = explain('read', JSON.stringify({ file_path: 'README.md' }), t)
assert.equal(read.cat, 'read')
assert.equal(read.risk, 'low')
assert.equal(read.target, 'README.md')
assert.equal(read.danger, false)
assert.ok(read.now.length > 0 && read.why.length > 0 && read.next.length > 0, 'the study lines are empty')
assert.ok(read.effect.length > 0 && read.undo.length > 0, 'explanation lines are empty')
assert.equal(read.what, undefined, 'the old what field is gone, replaced by now')

const write = explain('write', JSON.stringify({ file_path: 'src/a.ts', content: 'x' }), t)
assert.equal(write.risk, 'medium', 'a write must not read as low risk')

const risky = explain('pwsh', JSON.stringify({ command: 'Remove-Item -Recurse -Force .\\dist' }), t)
assert.equal(risky.cat, 'exec')
assert.equal(risky.risk, 'high', 'a recursive delete must be flagged')
assert.equal(risky.danger, true)
// A dangerous command gets the danger wording, not the calm exec wording.
assert.ok(risky.why.includes('删除或覆盖'), 'a dangerous command explains its danger')
assert.ok(risky.next.includes('取决于你答不答应'), 'and says the next step depends on the answer')

const plain = explain('pwsh', JSON.stringify({ command: 'npm test' }), t)
assert.equal(plain.danger, false, 'a plain command must not be flagged')
assert.equal(plain.target, 'npm test')

// Malformed and missing arguments must degrade, never throw.
const partial = explain('edit', '{"file_path":"a.ts","old_str', t)
assert.equal(partial.cat, 'write')
assert.equal(partial.target, '', 'partial JSON has no readable target')
assert.equal(explain('read', '', t).cat, 'read')
assert.equal(explain(undefined, undefined, t).cat, 'control', 'unknown tool falls back to a generic category')
assert.equal(explain('read', '[1,2]', t).target, '', 'a JSON array is not an argument object')

// Unknown tools still answer with words, not keys.
const unknown = explain('some_future_tool', '{}', t)
for (const field of ['now', 'why', 'next', 'effect', 'undo']) {
  assert.ok(!unknown[field].startsWith('cat.') && !unknown[field].startsWith('why.') && !unknown[field].startsWith('next.'), `unknown category leaked a key in ${field}`)
}
const cordsTool = explain('cordis_inspect_list', '{}', t)
assert.equal(cordsTool.cat, 'read', 'inspectors are read-only')

// A long target is clipped rather than allowed to blow up the row.
assert.equal(explain('read', JSON.stringify({ file_path: 'x'.repeat(400) }), t).target.length, 160)

// --- tool call shapes ------------------------------------------------
assert.deepEqual(callOf(undefined), { name: '', argsRaw: '' })
assert.deepEqual(callOf({ phase: 'start', name: 'read', argsRaw: '{"file_path":"a"}' }), {
  name: 'read',
  argsRaw: '{"file_path":"a"}',
})
assert.deepEqual(callOf({ kind: 'tool-result', call: { name: 'edit', argsRaw: '{"file_path":"b"}' } }), {
  name: 'edit',
  argsRaw: '{"file_path":"b"}',
})
assert.deepEqual(callOf({ kind: 'tool-result', call: null, name: '' }), { name: '', argsRaw: '' })

const nodes = [
  { kind: 'tool-call', location: { turn: { turn: 2 } }, data: { root: { phase: 'start', callId: 'c1', name: 'read', argsRaw: '{"file_path":"a"}' } } },
  { kind: 'tool-call', location: { turn: { turn: 2 } }, data: { root: { kind: 'tool-result', callId: 'c2', call: { name: 'grep', argsRaw: '{"pattern":"x"}' } } } },
  { kind: 'tool-call', location: { turn: { turn: 3 } }, data: { root: { phase: 'start', callId: 'c3', name: 'write', argsRaw: '{"file_path":"b"}' } } },
  { kind: 'tool-call', visibility: 'hidden', location: { turn: { turn: 2 } }, data: { root: { phase: 'start', callId: 'c4', name: 'read', argsRaw: '{}' } } },
  { kind: 'assistant-step', location: { turn: { turn: 2 } }, data: {} },
]
assert.equal(rootOf(nodes, 'c2').callId, 'c2')
assert.equal(rootOf(nodes, 'missing'), undefined)
assert.deepEqual(stepsOf(nodes, 2, t).map((step) => step.tool), ['read', 'grep'], 'turn 2 only, hidden nodes skipped')
assert.deepEqual(stepsOf(nodes, 3, t).map((step) => step.tool), ['write'])
assert.deepEqual(stepsOf(nodes, 99, t), [])
assert.deepEqual(stepsOf(nodes, undefined, t), [], 'no turn number means no steps')

// --- summary line ----------------------------------------------------
const grouped = groupSteps(stepsOf(nodes, 2, t), t)
assert.equal(grouped, '读取文件 1 · 按内容搜索 1')

// --- dictionaries ----------------------------------------------------
for (const dict of [zh, en]) {
  for (const key of ['cat.read.label', 'cat.exec.effect', 'risk.high', 'approval.danger', 'no.control']) {
    assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `missing ${key}`)
  }
}
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en must cover the same keys')

// Every category the explainer can produce needs words in both languages.
for (const cat of new Set(['read', 'search', 'write', 'exec', 'net', 'ask', 'control'])) {
  for (const key of [`cat.${cat}.label`, `cat.${cat}.what`, `cat.${cat}.effect`, `cat.${cat}.undo`, `ok.${cat}`, `no.${cat}`]) {
    assert.ok(zh[key] !== undefined && en[key] !== undefined, `missing ${key}`)
  }
}

// Every literal t('...') key in client.js must exist in the dictionaries.
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
for (const [, key] of source.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)) {
  assert.ok(zh[key] !== undefined, `client.js uses unknown dictionary key "${key}"`)
}

// --- rendered surfaces -----------------------------------------------
// Components are plain functions of props; a fake useChat runs the selector
// against a snapshot the way the real hook does.
const snapshotOf = (nodes, runningCalls = []) => ({
  nodes: { values: () => nodes },
  legacy: { runningCalls },
})
const render = (Component, props, snapshot) =>
  mount(Component({ ...props, t, useChat: (selector) => selector(snapshot) }))

/**
 * Expand function components the way the renderer would, so a helper walks a
 * real host-element tree. Leaf components here only take props and return
 * elements, so calling them is a faithful stand-in.
 */
const mount = (node) =>
  node === null || node === undefined || node === false || typeof node === 'string' || typeof node === 'number'
    ? node
    : Array.isArray(node)
      ? node.map(mount)
      : typeof node.type === 'function'
        ? mount(node.type({ ...node.props, children: node.children }))
        : { ...node, children: mount(node.children) }

/** Flatten a rendered element tree into the text a user would read. */
const textOf = (node) =>
  node === null || node === undefined || node === false || typeof node === 'boolean'
    ? ''
    : typeof node === 'string' || typeof node === 'number'
      ? String(node)
      : Array.isArray(node)
        ? node.map(textOf).join(' ')
        : textOf(node.children)

// Nothing is running and the turn has no tool calls: both surfaces stay silent.
assert.equal(render(built.__test.LiveStep, {}, snapshotOf([])), null, 'a quiet composer shows no dock')
assert.equal(render(built.__test.TurnSummary, { turn: { turn: 99 } }, snapshotOf(nodes)), null, 'a turn with no tool calls shows no summary')

// A running call shows up in the dock, unexpanded, with its target.
const live = render(built.__test.LiveStep, {}, snapshotOf([], [{ phase: 'start', callId: 'c9', name: 'read', argsRaw: '{"file_path":"a.ts"}' }]))
const liveText = textOf(live)
assert.ok(liveText.includes('正在读取文件'), 'dock names the running step')
assert.ok(liveText.includes('a.ts'), 'dock shows what it acts on')
assert.ok(liveText.includes('这是什么') && !liveText.includes('影响：'), 'dock starts collapsed')

// A settled turn summarizes its steps and can list them.
const summary = render(built.__test.TurnSummary, { turn: { turn: 2 } }, snapshotOf(nodes))
assert.ok(textOf(summary).includes('本轮 2 步'), 'summary counts the turn steps')
assert.ok(!textOf(summary).includes('影响：'), 'summary starts collapsed')

// The shared Detail block is what every expanded surface shows, so its study
// lines are checked directly: a regression here would silently flatten two of
// the three levels everywhere at once.
{
  const info = built.__test.explain('read', '{"file_path":"a.ts"}', t)
  const expanded = (study) => {
    built.__test.setStudy(study)
    return textOf(render(built.__test.Detail, { info }))
  }
  const atNow = expanded('now')
  assert.ok(atNow.includes('当前在做什么'), 'the detail block names the action')
  assert.ok(!atNow.includes('为什么这样做') && !atNow.includes('下一步可能'), 'at the first level it adds neither')
  assert.ok(atNow.includes('影响：') && atNow.includes('能否撤回：'), 'and keeps the effect and undo lines')
  const atWhy = expanded('why')
  assert.ok(atWhy.includes('为什么这样做'), 'the second level adds the why line')
  assert.ok(!atWhy.includes('下一步可能'), 'still without the next line')
  const atPlan = expanded('plan')
  assert.ok(atPlan.includes('下一步可能'), 'the third level adds the next line')
  assert.ok(atPlan.length > atWhy.length && atWhy.length > atNow.length, 'and each level is longer than the last')
  // Back to the shipped default, so later blocks see what a new reader would.
  built.__test.setStudy('plan')
}

// --- the model switch ------------------------------------------------
// Off must mean no request at all: this is the difference between "free and
// local" and "one API call per step", so it is asserted at the fetch boundary.
// A live hook runtime is used because the request is issued from an effect,
// and `render` above calls components without committing effects.
{
  const asked = []
  const realFetch = globalThis.fetch
  const realUseState = React.useState
  const realUseEffect = React.useEffect
  let cells = []
  let cursor = 0
  let queued = []
  React.useState = (initial) => {
    const index = cursor++
    if (!(index in cells)) cells[index] = initial
    return [cells[index], (next) => (cells[index] = typeof next === 'function' ? next(cells[index]) : next)]
  }
  React.useEffect = (fn) => queued.push(fn)
  globalThis.fetch = async (url, init = {}) => {
    asked.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    return { ok: true, json: async () => ({ detail: '模型写的一句说明' }) }
  }
  const draw = () => {
    cursor = 0
    queued = []
    // `Detail` now nests `Explanation`, so the tree must be expanded the way the
    // renderer would; calling the component alone would skip the child.
    const tree = mount(built.__test.Detail({ info, t }))
    const effects = queued
    queued = []
    for (const effect of effects) effect()
    return tree
  }
  const info = built.__test.explain('read', '{"file_path":"a.ts"}', t)
  built.__test.setExplain(false)
  cells = []
  const off = textOf(draw())
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(asked.length, 0, 'with the switch off, no step asks any model')
  // Off means the local rules are the whole explanation: no model text, no
  // "a model wrote this" label, and no waiting line either.
  assert.ok(off.includes('当前在做什么'), 'off: the local rule explanation is what the reader sees')
  assert.ok(!off.includes('以上解释由模型生成'), 'off: nothing claims a model wrote it')
  assert.ok(!off.includes('正在让模型补充'), 'off: no waiting line, because nothing is being asked')

  built.__test.setExplain(true)
  cells = []
  draw()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(asked.length, 1, 'with it on, one request per step')
  assert.equal(asked[0].url, 'api/step-explain.detail', 'and it goes to the detail route')
  assert.deepEqual(
    { name: asked[0].body.name, argsRaw: asked[0].body.argsRaw },
    { name: 'read', argsRaw: '{"file_path":"a.ts"}' },
    'carrying the same call the rule text explained, and nothing else',
  )
  assert.ok(
    Object.keys(asked[0].body).every((key) => ['name', 'argsRaw', 'lang', 'study'].includes(key)),
    'no session content leaves the browser',
  )
  assert.equal(asked[0].body.study, 'plan', 'the study level rides along, so the model writes at the same depth')
  // Once the answer arrives it replaces the rule explanation, while the impact
  // and undo lines — the facts the reader decides on — stay local.
  const replaced = textOf(draw())
  assert.ok(replaced.includes('模型写的一句说明'), 'the model text is what the reader sees')
  assert.ok(!replaced.includes('当前在做什么'), 'and the rule explanation is replaced, not stacked under it')
  assert.ok(replaced.includes('影响：') && replaced.includes('能否撤回：'), 'the local impact and undo lines survive')
  assert.ok(replaced.includes('以上解释由模型生成'), 'and the text says a model wrote it')

  // The same call is not asked twice: reopening a summary must be free.
  const before = asked.length
  cells = []
  draw()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(asked.length, before, 'a repeat view of the same call comes from the cache, not the model')

  // One request at a time, so a ten-step summary cannot fire ten at once.
  {
    let inFlight = 0
    let peak = 0
    globalThis.fetch = async (url, init = {}) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      asked.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body) })
      return { ok: true, json: async () => ({ detail: `答案${asked.length}` }) }
    }
    // Three different calls at once, as an expanded summary would produce.
    const other = ['a.ts', 'b.ts', 'c.ts'].map((file) => built.__test.explain('read', JSON.stringify({ file_path: file }), t))
    cells = []
    cursor = 0
    queued = []
    const trees = other.map((each) => mount(built.__test.Detail({ info: each, t })))
    const effects = queued
    queued = []
    for (const effect of effects) effect()
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(peak, 1, 'explanation requests are serialised, never concurrent')
    assert.equal(asked.length, 3, 'and every call still gets its own answer')
    void trees
  }

  // A chatty model cannot push the impact and undo lines off screen.
  assert.equal(built.__test.clipModelLine('x'.repeat(400)).length, 240, 'a long answer is clipped to the layout limit')
  assert.ok(built.__test.clipModelLine('x'.repeat(400)).endsWith('…'), 'and ends with an ellipsis')
  assert.equal(built.__test.clipModelLine('  short   one  '), 'short one', 'a short answer is only flattened')

  built.__test.setExplain(false)
  globalThis.fetch = realFetch
  React.useState = realUseState
  React.useEffect = realUseEffect
}

// The approval cell explains the correlated call and names both outcomes.
const approval = render(
  built.__test.ApprovalDetail,
  { callId: 'c5' },
  snapshotOf([{ kind: 'tool-call', data: { root: { phase: 'start', callId: 'c5', name: 'pwsh', argsRaw: '{"command":"Remove-Item -Recurse .\\\\out"}' } } }]),
)
const approvalText = textOf(approval)
assert.ok(approvalText.includes('运行 PowerShell 命令'), 'approval names the step')
assert.ok(approvalText.includes('会动到数据'), 'approval states the risk level')
assert.ok(approvalText.includes('点“允许”') && approvalText.includes('点“拒绝”'), 'approval explains both answers')
assert.ok(approvalText.includes('删除或覆盖数据'), 'dangerous command gets the warning line')
assert.ok(!approvalText.includes('影响：'), 'approval does not repeat the generic lines')
// All three levels are listed at once: a cycle button used to show only the
// level you were already on, so the other two never became visible.
assert.ok(
  approvalText.includes('基础') && approvalText.includes('模型补充') && approvalText.includes('完整说明'),
  'all three levels are visible in the dialog',
)
// Study level: the default is the fullest one, because the plugin exists to say
// what a step is for and what follows. Turning it down is the opt-in.
assert.ok(approvalText.includes('当前在做什么'), 'the approval names the current action')
assert.ok(approvalText.includes('为什么这样做'), 'the default study level explains why')
assert.ok(approvalText.includes('下一步可能'), 'and what commonly comes next')

// The switch must reach the approval dialog too: it is one of the surfaces the
// setting promises, and it was the one that used to ignore it.
{
  const asked = []
  const realFetch = globalThis.fetch
  const realUseState = React.useState
  const realUseEffect = React.useEffect
  let cells = []
  let cursor = 0
  let queued = []
  React.useState = (initial) => {
    const index = cursor++
    if (!(index in cells)) cells[index] = initial
    return [cells[index], (next) => (cells[index] = typeof next === 'function' ? next(cells[index]) : next)]
  }
  React.useEffect = (fn) => queued.push(fn)
  globalThis.fetch = async (url, init = {}) => {
    asked.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    return { ok: true, json: async () => ({ detail: '模型写的审批说明' }) }
  }
  const snap = snapshotOf([
    { kind: 'tool-call', data: { root: { phase: 'start', callId: 'c5', name: 'pwsh', argsRaw: '{"command":"npm test"}' } } },
  ])
  // `fresh` resets the hook cells (a newly mounted tree); the default keeps them
  // so a second draw shows what the reader sees after the answer lands.
  const drawApproval = (fresh = true) => {
    if (fresh) cells = []
    cursor = 0
    queued = []
    const tree = mount(built.__test.ApprovalDetail({ callId: 'c5', useChat: (select) => select(snap), t }))
    const effects = queued
    queued = []
    for (const effect of effects) effect()
    return tree
  }

  // Switch off and the dialog's level on "basic": no request at all.
  built.__test.setExplain(false)
  built.__test.setDetail('rule')
  drawApproval()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(asked.length, 0, 'off and basic: the approval dialog asks no model')

  // Switch on: the dialog explains through the model, like every other surface.
  built.__test.setExplain(true)
  drawApproval()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(asked.length >= 1, 'on: the approval dialog asks the model too')
  // Same state, drawn again: this is what the reader sees after the answer lands.
  const withModel = textOf(drawApproval(false))
  assert.ok(withModel.includes('模型写的审批说明'), 'on: the dialog shows the model text')

  // The dialog's own "model notes" level still works with the switch off. A
  // different command is used because the answer for the previous one is cached.
  asked.length = 0
  built.__test.setExplain(false)
  built.__test.setDetail('model')
  const otherSnap = snapshotOf([
    { kind: 'tool-call', data: { root: { phase: 'start', callId: 'c6', name: 'pwsh', argsRaw: '{"command":"npm run build"}' } } },
  ])
  cells = []
  cursor = 0
  queued = []
  mount(built.__test.ApprovalDetail({ callId: 'c6', useChat: (select) => select(otherSnap), t }))
  const pending = queued
  queued = []
  for (const effect of pending) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(asked.length >= 1, 'the model-notes level still asks on its own, without the switch')
  // Its waiting text names that trigger, not the global switch.
  cells = []
  cursor = 0
  queued = []
  const waiting = mount(built.__test.ApprovalDetail({ callId: 'c7', useChat: (select) => select(snapshotOf([
    { kind: 'tool-call', data: { root: { phase: 'start', callId: 'c7', name: 'pwsh', argsRaw: '{"command":"npm run lint"}' } } },
  ])), t }))
  const pending2 = queued
  queued = []
  for (const effect of pending2) effect()
  assert.ok(textOf(waiting).includes('正在让模型补充这一档的说明'), 'and its waiting text names that trigger')

  // A failed model answer is stated, not silently dropped: the reader has to
  // know the lines above are the rule text, and that reopening is a real retry.
  built.__test.setDetail('rule')
  built.__test.setExplain(true)
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
  const failSnap = snapshotOf([
    { kind: 'tool-call', data: { root: { phase: 'start', callId: 'c8', name: 'pwsh', argsRaw: '{"command":"npm run deploy"}' } } },
  ])
  const drawFail = (fresh) => {
    if (fresh) cells = []
    cursor = 0
    queued = []
    const tree = mount(built.__test.ApprovalDetail({ callId: 'c8', useChat: (select) => select(failSnap), t }))
    const effects = queued
    queued = []
    for (const effect of effects) effect()
    return tree
  }
  drawFail(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(
    textOf(drawFail(false)).includes('模型这次没答上来'),
    'a failed model answer says so instead of leaving the waiting line to vanish',
  )

  built.__test.setDetail('rule')
  built.__test.setExplain(false)
  globalThis.fetch = realFetch
  React.useState = realUseState
  React.useEffect = realUseEffect
}
// The cell may own a toggle, but never an answer: the shipped dialog decides.
// Its Enter handler skips `button`, and every control here is type="button".
const controlsOf = (node) =>
  node === null || node === undefined || node === false || typeof node === 'string' || typeof node === 'number'
    ? []
    : Array.isArray(node)
      ? node.flatMap(controlsOf)
      : [node, ...controlsOf(node.children)]
const controls = controlsOf(approval).filter((node) => typeof node.type === 'string' && /^(button|input|form|select|textarea)$/.test(node.type))
assert.deepEqual(
  controls.map((node) => [node.type, node.props.type]),
  [['button', 'button'], ['button', 'button'], ['button', 'button']],
  'the approval cell renders only its three level buttons, and none is ever a submit',
)

// The risk level must survive for a screen reader wherever no text states it.
const ariaLabels = (node) =>
  node === null || node === undefined || node === false || typeof node === 'string' || typeof node === 'number'
    ? []
    : Array.isArray(node)
      ? node.flatMap(ariaLabels)
      : [node.props?.['aria-label'], ...ariaLabels(node.children)].filter(Boolean)
// The risk word is now printed next to the dot, so it survives greyscale and
// colour blindness instead of living only in an aria-label.
assert.ok(textOf(live).includes('低风险'), 'the dock prints the risk level beside the dot')
// The three level buttons are a labelled group, so a screen reader hears what
// the three buttons are for.
assert.ok(
  ariaLabels(approval).includes('审批框里说多细'),
  'the level group is named',
)
assert.deepEqual(
  (() => {
    const found = []
    const walk = (node) => {
      if (node === null || node === undefined || node === false || typeof node === 'string' || typeof node === 'number') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (node.props?.className === 'dse-dot') found.push(node.props)
      walk(node.children)
    }
    walk(approval)
    return found
  })(),
  [{ className: 'dse-dot', style: { background: 'var(--dsw-alias-state-error-primary)' }, 'aria-hidden': true }],
  'the approval dot is decorative: the level is already printed as text',
)

// A missing call degrades to nothing instead of throwing.
assert.equal(render(built.__test.ApprovalDetail, { callId: 'nope' }, snapshotOf(nodes)), null)
assert.equal(render(built.__test.ApprovalDetail, { callId: 'c1' }, snapshotOf(nodes)).type, 'div', 'a running call is found by id')

// The command shown in the approval dialog is never clipped, unlike a row target.
const longCommand = `npm run ${'build-'.repeat(60)}`
assert.equal(explain('pwsh', JSON.stringify({ command: longCommand }), t).target.length, 160, 'row targets are clipped')
const longApproval = textOf(
  render(
    built.__test.ApprovalDetail,
    { callId: 'c7' },
    snapshotOf([{ kind: 'tool-call', data: { root: { phase: 'start', callId: 'c7', name: 'pwsh', argsRaw: JSON.stringify({ command: longCommand }) } } }]),
  ),
)
assert.ok(longApproval.includes(longCommand), 'the approval dialog shows the whole command')
assert.equal(built.__test.commandOf({ phase: 'start', argsRaw: '{"command":"ls"}' }), 'ls')
assert.equal(built.__test.commandOf({ phase: 'start', argsRaw: 'not json' }), '', 'a malformed call has no command')
assert.equal(built.__test.commandOf(undefined), '')

// A write approval names the file and both outcomes, with no command block.
const writeApproval = textOf(
  render(
    built.__test.ApprovalDetail,
    { callId: 'c8' },
    snapshotOf([{ kind: 'tool-call', data: { root: { phase: 'start', callId: 'c8', name: 'write', argsRaw: '{"file_path":"notes.md"}' } } }]),
  ),
)
assert.ok(writeApproval.includes('写入文件') && writeApproval.includes('需留意'), 'write approval names the tool and risk')
assert.ok(writeApproval.includes('notes.md'), 'write approval names the file')
assert.ok(!writeApproval.includes('删除或覆盖数据'), 'a plain write gets no danger warning')

// --- optional model detail -------------------------------------------
// The request is exactly what the Host validates: a tool name, its raw
// arguments, the answer language and the study level, and nothing about the session.
assert.deepEqual(detailPayload({ name: 'read', argsRaw: '{"file_path":"a"}' }, 'zh', 'why'), {
  name: 'read',
  argsRaw: '{"file_path":"a"}',
  lang: 'zh',
  study: 'why',
})
assert.deepEqual(detailPayload({ name: '', argsRaw: '' }, 'en', 'now'), { name: '', argsRaw: '', lang: 'en', study: 'now' })

// The model is never in the request: the Host reads the saved profile itself.
// Even handed a model pair by mistake, the payload carries only the call.
const withModel = detailPayload({ name: 'read', argsRaw: '{}', model: { provider: 'p', model: 'm' } }, 'en', 'now')
assert.deepEqual(withModel, { name: 'read', argsRaw: '{}', lang: 'en', study: 'now' })
assert.ok(!('model' in withModel), 'the model choice never rides on the request')

// Any response that is not a string detail explains nothing rather than throwing.
assert.equal(pickDetail({ detail: '一句话' }), '一句话')
assert.equal(pickDetail({ detail: '' }), '')
assert.equal(pickDetail({ detail: 7 }), '')
assert.equal(pickDetail({}), '')
assert.equal(pickDetail(null), '')
assert.equal(pickDetail('text'), '')

// Three levels, basic until the reader changes it, and storage failure is not fatal.
assert.equal(built.__test.readDetail(), 'rule')
assert.deepEqual(built.__test.LEVELS, ['rule', 'model', 'full'], 'three levels, in increasing detail')
const store = new Map()
globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
built.__test.setDetail('model')
assert.equal(store.get('dsh-step-explain/detail'), 'model', 'the level is remembered per browser')
assert.equal(built.__test.readDetail(), 'model')
built.__test.setDetail('full')
assert.equal(store.get('dsh-step-explain/detail'), 'full')
assert.equal(built.__test.readDetail(), 'full')
// An unknown or old stored value falls back to the plain rule text.
store.set('dsh-step-explain/detail', 'on')
assert.equal(built.__test.readDetail(), 'rule', 'an old on/off value is not a level')
store.set('dsh-step-explain/detail', 'nonsense')
assert.equal(built.__test.readDetail(), 'rule', 'garbage is not a level')
built.__test.setDetail('nonsense')
assert.equal(built.__test.readDetail(), 'rule', 'an unknown level never sticks')
built.__test.setDetail('rule')
assert.equal(store.get('dsh-step-explain/detail'), 'rule')
delete globalThis.localStorage

// With the level at basic, the approval cell asks the Host for nothing and still explains.
const offApproval = textOf(
  render(
    built.__test.ApprovalDetail,
    { callId: 'c5' },
    snapshotOf([{ kind: 'tool-call', data: { root: { phase: 'start', callId: 'c5', name: 'read', argsRaw: '{"file_path":"a.ts"}' } } }]),
  ),
)
assert.ok(offApproval.includes('以上只是说明，不会替你选择。'), 'at the basic level the cell keeps the rule-based footnote')
assert.ok(!offApproval.includes('正在让模型补充说明'), 'the basic level asks the Host for nothing')
assert.ok(!offApproval.includes('这个框是干什么的'), 'the basic level adds no full explanation')

// The full level spells out the dialog, and still owns no answer.
built.__test.setDetail('full')
const fullNode = render(
  built.__test.ApprovalDetail,
  { callId: 'c5' },
  snapshotOf([{ kind: 'tool-call', data: { root: { phase: 'start', callId: 'c5', name: 'read', argsRaw: '{"file_path":"a.ts"}' } } }]),
)
const fullApproval = textOf(fullNode)
for (const heading of ['这个框是干什么的', '为什么会弹出来', '框里这几行分别是什么', '你能做的选择', '注意']) {
  assert.ok(fullApproval.includes(heading), `the full level covers "${heading}"`)
}
// The five parts must say more than the rule text alone, and name the real choices.
assert.ok(fullApproval.length > offApproval.length * 2, 'the full level is substantially longer than the basic one')
assert.ok(fullApproval.includes('允许') && fullApproval.includes('拒绝'), 'the full level names both answers')
assert.ok(fullApproval.includes('读取文件'), 'the full level reuses the real effect of this call')
{
  const levels = controlsOf(fullNode).filter(
    (node) => node.type === 'button' && ['基础', '模型补充', '完整说明'].includes(textOf(node).trim()),
  )
  assert.deepEqual(levels.map((node) => node.props['aria-pressed']), [false, false, true], 'the full level reads as current')
}
// Only the level button — no allow/reject control ever comes from this cell.
const fullControls = controlsOf(fullNode).filter((node) => typeof node.type === 'string' && /^(button|input|form|select|textarea)$/.test(node.type))
assert.deepEqual(fullControls.map((node) => node.props.type), ['button', 'button', 'button'], 'the cell renders only its three level buttons, never an answer control')

// The model level adds the model paragraph on top of the rule text, not instead of it.
built.__test.setDetail('model')
const modelLevel = textOf(
  render(
    built.__test.ApprovalDetail,
    { callId: 'c5' },
    snapshotOf([{ kind: 'tool-call', data: { root: { phase: 'start', callId: 'c5', name: 'read', argsRaw: '{"file_path":"a.ts"}' } } }]),
  ),
)
assert.ok(modelLevel.includes('正在让模型补充这一档的说明'), 'the model level asks the Host for a paragraph')
assert.ok(!modelLevel.includes('这个框是干什么的'), 'the model level does not print the full explanation')
built.__test.setDetail('rule')

// --- study level ------------------------------------------------------
// Three levels that must add, never replace: naming the action, then why this
// kind of step exists, then what commonly comes next. Each one must be visibly
// different from the one below it, or the setting does nothing.
{
  const drawAt = (study) => {
    built.__test.setStudy(study)
    return textOf(
      render(
        built.__test.ApprovalDetail,
        { callId: 'c5' },
        snapshotOf([{ kind: 'tool-call', data: { root: { phase: 'start', callId: 'c5', name: 'read', argsRaw: '{"file_path":"a.ts"}' } } }]),
      ),
    )
  }
  const now = drawAt('now')
  const why = drawAt('why')
  const plan = drawAt('plan')

  assert.ok(now.includes('当前在做什么'), 'the first study level names the action')
  assert.ok(!now.includes('为什么这样做') && !now.includes('下一步可能'), 'and only that')

  assert.ok(why.includes('当前在做什么'), 'the second level keeps the action')
  assert.ok(why.includes('为什么这样做'), 'and adds why')
  assert.ok(why.includes('通常是为了先把要改的东西看清楚'), 'the why line is the read category text')
  assert.ok(!why.includes('下一步可能'), 'but still no next line')

  assert.ok(plan.includes('为什么这样做'), 'the third level keeps the action and the why')
  assert.ok(plan.includes('下一步可能'), 'and adds what comes next')
  assert.ok(plan.includes('下一步多半是继续读相关文件'), 'the next line is the read category text')
  assert.ok(plan.length > why.length && why.length > now.length, 'each level is longer than the one below it')

  // The three levels must not all say the same thing.
  assert.equal(new Set([now, why, plan]).size, 3, 'every study level reads differently')

  // A dangerous command gets the danger wording at the same levels, not the calm one.
  built.__test.setStudy('plan')
  const danger = textOf(
    render(
      built.__test.ApprovalDetail,
      { callId: 'c5' },
      snapshotOf([{ kind: 'tool-call', data: { root: { phase: 'start', callId: 'c5', name: 'pwsh', argsRaw: '{"command":"Remove-Item -Recurse .\\\\out"}' } } }]),
    ),
  )
  assert.ok(danger.includes('这条命令会删除或覆盖数据'), 'a dangerous command gets the danger why')
  assert.ok(danger.includes('取决于你答不答应'), 'and the danger next line')
  assert.ok(!danger.includes('通常是为了验证、构建或运行'), 'not the calm exec wording')

  // An unknown stored value falls back to the default instead of crashing.
  built.__test.setStudy('nonsense')
  assert.equal(built.__test.readStudy(), 'plan', 'an unreadable study level falls back to the default')
  built.__test.setStudy('plan')
}

// --- settings row ----------------------------------------------------
// The choice lives in the profile, not in this browser: the row reads it from
// the Host and writes it back through the same route the shipped page uses.
const host = { model: null, fail: false, writes: [] }
globalThis.fetch = async (url, init = {}) => {
  if (url !== 'api/step-explain.model') throw new Error(`unexpected fetch ${url}`)
  if (init.method === 'GET') {
    if (host.fail) return { ok: false, status: 409, json: async () => ({}) }
    return { ok: true, json: async () => ({ model: host.model }) }
  }
  const body = JSON.parse(init.body)
  host.writes.push(body)
  if (host.fail) return { ok: false, status: 409, json: async () => ({ error: 'unavailable' }) }
  host.model = body.provider === undefined ? null : { provider: body.provider, model: body.model }
  return { ok: true, json: async () => ({ model: host.model }) }
}

// Nothing saved yet: the row reads back "follow the chat".
assert.equal(await built.__test.loadModel(), null, 'no saved choice reads as null')
assert.deepEqual(await built.__test.saveModel({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
assert.deepEqual(host.writes.at(-1), { provider: 'p', model: 'm' }, 'the pair is what gets written')
assert.deepEqual(await built.__test.loadModel(), { provider: 'p', model: 'm' }, 'and it reads back after a reload')

// Clearing sends an empty body, which is how the profile override is removed.
assert.equal(await built.__test.saveModel(null), null)
assert.deepEqual(host.writes.at(-1), {}, 'clearing writes an empty override')
assert.equal(await built.__test.loadModel(), null)

// A refused write reports failure instead of pretending to save.
host.fail = true
assert.equal(await built.__test.saveModel({ provider: 'p', model: 'm' }), undefined, 'a failed save is not a saved value')
assert.equal(await built.__test.loadModel(), undefined, 'a failed read is not "no choice"')
host.fail = false

// A half pair never round-trips as a choice.
host.model = { provider: 'p' }
assert.equal(await built.__test.loadModel(), null, 'a half saved pair is ignored')
host.model = { provider: 'p', model: 'm' }
delete globalThis.fetch

// The row renders a select with a follow-chat default, and is not an approval control.
const row = mount(built.__test.SettingsRow({ t }))
const rowText = textOf(row)
assert.ok(rowText.includes('步骤说明的详细版由哪个模型写'), 'the row has a title')
assert.ok(rowText.includes('跟随聊天模型'), 'the default option follows the chat model')
const selects = controlsOf(row).filter((node) => node.type === 'select')
assert.equal(selects.length, 1, 'the row has exactly one select')
assert.equal(selects[0].props.value, '', 'no choice shows the follow-chat option')
assert.equal(selects[0].props['aria-label'], '步骤说明的详细版由哪个模型写', 'the select is labelled')

// --- settings page ---------------------------------------------------
// The page repeats the same two settings with room to explain each one, so it
// must agree with the row and never grow a third state of its own.
const page = mount(built.__test.SettingsPage({ t }))
const pageText = textOf(page)
// Both surfaces render one shared picker, so their selects must be identical.
// A second copy would drift the moment either save path changes.
{
  const pageSelect = controlsOf(page).find((node) => node.type === 'select')
  assert.ok(pageSelect !== undefined, 'the page has the model picker')
  // Compare what the reader can see. `onChange` is a fresh closure per render,
  // so it is checked by behaviour below instead of by identity.
  const visible = (node) => ({ ...node.props, onChange: undefined, children: undefined })
  assert.deepEqual(visible(pageSelect), visible(selects[0]), 'the page and the row render the same picker')
  assert.deepEqual(JSON.stringify(pageSelect.children), JSON.stringify(selects[0].children), 'and the same options')
  // One definition of the select in the source: a second copy would drift.
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.equal(
    (source.match(/className: 'dse-select'/g) ?? []).length,
    1,
    'the select is built in exactly one place',
  )
}
assert.ok(pageText.includes('步骤说明'), 'the page has a title')
assert.ok(pageText.includes('说明的详细程度'), 'the page groups the explanation setting')
assert.ok(pageText.includes('审批框里说多细'), 'the page names the level setting')
assert.ok(pageText.includes('讲解深度'), 'the page names the study level setting')
for (const level of ['基础', '模型补充', '完整说明']) {
  // The row title supplies the "详细程度" prefix; each button carries only the
  // level name, so three buttons still fit the right-hand column.
  assert.ok(pageText.includes(level), `the page offers the "${level}" level`)
}
assert.ok(!pageText.includes('详细程度：基础'), 'the button does not repeat the row title prefix')
// Two three-level groups: the approval dialog's detail and the study level.
// They are separate settings, so each keeps its own set of three buttons.
// The context row is now three modes as well, and the model switch is the only
// on/off pair left.
const levelButtons = controlsOf(page).filter((node) => node.type === 'button')
assert.equal(levelButtons.length, 11, 'the page shows three three-level groups, one on/off pair and the docs toggle')
assert.deepEqual(
  levelButtons.map((node) => textOf(node)),
  ['基础', '模型补充', '完整说明', '做什么', '为什么', '下一步', '关闭', '开启', '不读', '挑选聊天内容', '展开说明'],
  'each button is labelled with its level only',
)
assert.deepEqual(
  // The docs entry is a disclosure, so it carries aria-expanded rather than
  // aria-pressed; `undefined` there is correct, not a missing state.
  levelButtons.map((node) => node.props['aria-pressed']),
  [true, false, false, false, false, true, true, false, true, false, undefined],
  'each group marks its own current level: Basic for the dialog, the fullest for study, model off, context off',
)
// The level control must be reachable: the row that holds it lets the group
// wrap and grow rather than clipping it out of the scroll column.
assert.ok(
  levelButtons.every((node) => node.props.type === 'button' && node.props.disabled === undefined),
  'no level button is disabled',
)
const levelRow = controlsOf(page).find((node) => typeof node.props?.className === 'string' && node.props.className.includes('dse-setting-levels'))
assert.ok(levelRow !== undefined, 'the level row carries the stacking class')
assert.equal(pageText.includes('模型'), true, 'the page groups the model setting')
const pageSelects = controlsOf(page).filter((node) => node.type === 'select')
assert.equal(pageSelects.length, 1, 'the page has exactly one model select')
assert.equal(pageSelects[0].props.value, '', 'the page agrees with the row on the default')
// Choosing a level on the page is the same write path the approval box uses.
const pageStore = new Map()
globalThis.localStorage = { getItem: (key) => pageStore.get(key) ?? null, setItem: (key, value) => pageStore.set(key, value) }
built.__test.setDetail('model')
assert.equal(built.__test.readDetail(), 'model', 'a level picked on the page sticks')
assert.equal(pageStore.get('dsh-step-explain/detail'), 'model', 'and it lands in the same storage key')
built.__test.setDetail('rule')
delete globalThis.localStorage
// The page explains its own privacy boundary rather than leaving it implied.
assert.ok(
  pageText.includes('关闭「由当前模型生成每一步的解释」时，只有模型补充档会上网'),
  'the page says exactly which levels go online',
)
assert.ok(
  pageText.includes('打开后，任何一档都会把工具名和参数原文发给模型'),
  'and that the model switch widens it to every level',
)
assert.ok(pageText.includes('不渲染允许/拒绝按钮'), 'the page repeats the read-only boundary')
// It still owns no approval answer.
const pageControls = controlsOf(page).filter((node) => /^(button|input|form|select|textarea)$/.test(node.type))
assert.ok(
  pageControls.every((node) => node.type !== 'button' || node.props.type === 'button'),
  'every page button is a plain button, never a submit',
)

// The picked level must LOOK picked. A `dse-btn-on` rule placed before
// `.dse-btn` loses on source order at equal specificity, which makes all three
// buttons render identically even though the click works — the reader reports
// that as "cannot switch". Assert the cascade, not just the class name.
{
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  const css = source.slice(source.indexOf('const CSS ='), source.indexOf('if (typeof document'))
  const at = (selector) => css.indexOf(selector)
  assert.ok(at('.dse-btn{') >= 0, 'the base button rule exists')
  assert.ok(at('.dse-btn.dse-btn-on{') >= 0, 'the picked-level rule exists')
  assert.ok(
    at('.dse-btn.dse-btn-on{') > at('.dse-btn{'),
    'the picked-level rule comes after the base rule, or the base rule wins and nothing looks selected',
  )
  assert.ok(
    at('.dse-btn.dse-btn-on{') > at('.dse-btn:hover'),
    'and after hover, so a selected button stays selected while hovered',
  )
  // Two classes beat one, so it also outranks the base rule regardless of order.
  assert.ok(
    /\.dse-btn\.dse-btn-on\{[^}]*(border-color|color):/.test(css),
    'the picked state sets its own colour rather than relying on order alone',
  )
  assert.ok(!/^\.dse-btn-on\{/m.test(css), 'no leftover single-class state rule that the base rule overrides')
}

// --- clicking a level on the page actually changes it ------------------
// The block above renders through `mount`, which calls components directly and
// never commits effects — so it proves the buttons exist, not that they work.
// This block runs the page over a live hook runtime that commits effects and
// re-renders after the click, the way the shell does.
{
  let cells = []
  let cursor = 0
  let queued = []
  const realUseState = React.useState
  const realUseEffect = React.useEffect
  React.useState = (initial) => {
    const index = cursor++
    if (!(index in cells)) cells[index] = initial
    return [
      cells[index],
      (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next
      },
    ]
  }
  React.useEffect = (fn) => {
    queued.push(fn)
  }
  const liveStore = new Map()
  globalThis.localStorage = { getItem: (key) => liveStore.get(key) ?? null, setItem: (key, value) => liveStore.set(key, value) }
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({}) })

  const draw = () => {
    cursor = 0
    queued = []
    const tree = built.__test.SettingsPage({ t })
    // Commit: subscriptions must be live or the click has nowhere to land.
    const effects = queued
    queued = []
    for (const effect of effects) effect()
    return tree
  }
  // Two on/off pairs share the labels 关闭/开启, so a plain text lookup would
  // always hit the first. `nth` picks the occurrence, and the assertions below
  // name which pair they mean.
  const press = (tree, label, nth = 0) => {
    const matches = controlsOf(tree).filter((node) => node.type === 'button' && textOf(node) === label)
    const button = matches[nth]
    assert.ok(button !== undefined, `the "${label}" button #${nth} is rendered`)
    button.props.onClick()
  }
  const pressed = (tree) => controlsOf(tree).filter((node) => node.type === 'button' && node.props['aria-pressed'] === true).map(textOf)

  assert.deepEqual(pressed(draw()), ['基础', '下一步', '关闭', '不读'], 'the page opens on each group’s own default')
  press(draw(), '完整说明')
  assert.equal(liveStore.get('dsh-step-explain/detail'), 'full', 'the click is stored')
  assert.deepEqual(pressed(draw()), ['完整说明', '下一步', '关闭', '不读'], 'and the re-rendered page shows it as current')
  press(draw(), '模型补充')
  assert.equal(liveStore.get('dsh-step-explain/detail'), 'model', 'another level is picked the same way')
  assert.deepEqual(pressed(draw()), ['模型补充', '下一步', '关闭', '不读'], 'the page follows the new pick')
  // Back to basic, so the rest of the file starts where it expects to.
  press(draw(), '基础')
  assert.deepEqual(pressed(draw()), ['基础', '下一步', '关闭', '不读'], 'and it can go back')

  // The study level is its own setting: it moves without touching the detail one.
  press(draw(), '为什么')
  assert.equal(liveStore.get('dsh-step-explain/study'), 'why', 'the study pick is stored separately')
  assert.equal(liveStore.get('dsh-step-explain/detail'), 'rule', 'and does not disturb the detail level')
  assert.deepEqual(pressed(draw()), ['基础', '为什么', '关闭', '不读'], 'each group keeps its own current level')
  press(draw(), '做什么')
  assert.deepEqual(pressed(draw()), ['基础', '做什么', '关闭', '不读'], 'the study group follows its own pick')
  press(draw(), '下一步')
  assert.deepEqual(pressed(draw()), ['基础', '下一步', '关闭', '不读'], 'and it returns to the default level')

  // The model switch is a third, independent setting.
  press(draw(), '开启')
  assert.equal(liveStore.get('dsh-step-explain/explain'), 'on', 'turning the model on is stored')
  assert.equal(liveStore.get('dsh-step-explain/study'), 'plan', 'and leaves the study level alone')
  assert.deepEqual(pressed(draw()), ['基础', '下一步', '开启', '不读'], 'the switch shows as on')
  press(draw(), '关闭')
  assert.equal(liveStore.get('dsh-step-explain/explain'), 'off', 'and it can be turned off again')
  assert.deepEqual(pressed(draw()), ['基础', '下一步', '关闭', '不读'], 'back to the cheap default')

  // The context setting is the fourth, and it stores under its own key. It is a
  // two-mode choice: none, or the whole conversation with the reader picking.
  press(draw(), '挑选聊天内容')
  assert.equal(liveStore.get('dsh-step-explain/context'), 'full', 'the context mode is stored separately')
  assert.equal(liveStore.get('dsh-step-explain/explain'), 'off', 'and leaves the model switch alone')
  assert.deepEqual(pressed(draw()), ['基础', '下一步', '关闭', '挑选聊天内容'], 'only the context mode moved')
  press(draw(), '不读')
  assert.equal(liveStore.get('dsh-step-explain/context'), 'off', 'and it can be turned off again')
  assert.deepEqual(pressed(draw()), ['基础', '下一步', '关闭', '不读'], 'back to sending only the composer')

  // The notes are a disclosure: closed until asked for, then it explains the
  // parts that are not guessable from the labels (three modes, ticks, the cap).
  const closedDocs = draw()
  assert.ok(textOf(closedDocs).includes('功能说明'), 'the page names the notes section')
  assert.ok(!textOf(closedDocs).includes('「读取对话」的两个选择'), 'closed by default: no prose dumped on the page')
  assert.ok(!textOf(closedDocs).includes('内容发到哪里'), 'and none of the other notes either')
  press(closedDocs, '展开说明')
  const openDocs = draw()
  for (const heading of ['「读取对话」的两个选择', '勾选决定发送范围', '字数上限', '内容发到哪里']) {
    assert.ok(textOf(openDocs).includes(heading), `the notes explain "${heading}"`)
  }
  assert.ok(textOf(openDocs).includes('没勾的一律不发送'), 'the notes state the picking rule')
  press(openDocs, '收起说明')
  assert.ok(!textOf(draw()).includes('「读取对话」的两个选择'), 'and it closes again')

  React.useState = realUseState
  React.useEffect = realUseEffect
  delete globalThis.localStorage
  delete globalThis.fetch
}

// --- rewriting a rough instruction -----------------------------------
// The bar is stateful, so this block swaps in a mini hook runtime: the same
// component drawn again over the same state, the way React would after a click.
const hookState = []
const hookRefs = []
let hookCursor = 0
React.useState = (initial) => {
  const index = hookCursor++
  if (!(index in hookState)) hookState[index] = initial
  return [
    hookState[index],
    (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next
    },
  ]
}
React.useRef = (initial) => {
  const index = hookCursor++
  if (!(index in hookRefs)) hookRefs[index] = { current: initial }
  return hookRefs[index]
}
React.useEffect = () => {}

const posted = []
globalThis.fetch = async (url, init) => {
  posted.push({ url, body: JSON.parse(init.body) })
  return { ok: true, json: async () => ({ text: 'REWRITTEN' }) }
}
const writes = []
const inputActions = { setDraft: (text) => writes.push(text) }
// The bar reads `legacy.nodes` for the optional conversation context. These
// tests start with an empty conversation; the context block below fills it.
let chatNodes = []
const drawBar = (draft) => {
  hookCursor = 0
  return mount(
    built.__test.RewriteBar({
      t,
      useInput: (select) => select({ draft }),
      useChat: (select) => select({ nodes: { values: () => chatNodes }, legacy: { nodes: chatNodes } }),
      inputActions,
    }),
  )
}
/** Let the request promise settle, then draw what the reader would see. */
const settle = async (draft) => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return drawBar(draft)
}
/**
 * Draw a freshly mounted bar: the hook cells are cleared first, so a module-level
 * switch flipped between draws is picked up as its initial state, the way a newly
 * opened panel would see it.
 */
const freshBar = (draft) => {
  hookState.length = 0
  hookRefs.length = 0
  return drawBar(draft)
}
/** Let a request settle, then draw a fresh bar showing what the reader would see. */
const settleFresh = async (draft) => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return freshBar(draft)
}
const buttonNamed = (tree, label) => controlsOf(tree).find((node) => node.type === 'button' && textOf(node).trim() === label)
/** Choose 挑选聊天内容; the list is inline, so one click is enough. */
const expandBar = (draft) => {
  const first = drawBar(draft)
  const mode = controlsOf(first).find(
    (node) => node.type === 'button' && textOf(node).trim() === '挑选聊天内容' && node.props['aria-pressed'] !== true,
  )
  if (mode === undefined) return first
  mode.props.onClick()
  return drawBar(draft)
}

// An empty draft offers nothing, and the bar is never a submit surface.
assert.equal(drawBar(''), null, 'a quiet composer shows no rewrite offer')
assert.equal(drawBar('   '), null, 'whitespace alone is not a draft')
const offered = drawBar('把那个 bug 修了')
assert.ok(textOf(offered).includes('把这句话写清楚'), 'the bar names what it does')
assert.ok(textOf(offered).includes('帮我扩写'), 'the bar offers one action')
assert.ok(!textOf(offered).includes('采用'), 'nothing to accept before a rewrite arrives')

// Three length levels sit side by side; a two-state toggle would hide two of them.
const toneButtons = controlsOf(offered).filter(
  (node) => node.type === 'button' && ['简短', '适中', '详细'].includes(textOf(node).trim()),
)
assert.deepEqual(
  toneButtons.map((node) => textOf(node).trim()),
  ['简短', '适中', '详细'],
  'all three length levels are visible at once',
)
assert.deepEqual(
  toneButtons.map((node) => node.props['aria-pressed']),
  [false, false, true],
  'the default is the detailed level, and only that one is pressed',
)
// Picking a level is a plain click, not a toggle that hides the alternatives.
toneButtons[0].props.onClick()
const concise = drawBar('把那个 bug 修了')
assert.deepEqual(
  controlsOf(concise)
    .filter((node) => node.type === 'button' && ['简短', '适中', '详细'].includes(textOf(node).trim()))
    .map((node) => node.props['aria-pressed']),
  [true, false, false],
  'clicking 简短 moves the pressed state, with all three still shown',
)
assert.equal(toneButtons.length, 3, 'the control never collapses to two options')
assert.ok(
  controlsOf(offered)
    .filter((node) => node.type === 'button')
    .every((node) => node.props.type === 'button'),
  'every button is type=button: none can submit the message',
)
assert.equal(writes.length, 0, 'merely showing the offer writes nothing')

// One click posts the draft, the tone and the language — nothing else.
buttonNamed(offered, '帮我扩写').props.onClick()
assert.equal(posted.length, 1, 'one request per click')
assert.equal(posted[0].url, 'api/step-explain.rewrite')
assert.deepEqual(
  posted[0].body,
  { text: '把那个 bug 修了', tone: 'detailed', lang: 'en' },
  'the request is the draft and how to shape it, with no session content',
)
// With the context switch off (the default) nothing about the conversation
// leaves the browser: the key is absent, not merely empty.
assert.ok(!('context' in posted[0].body), 'context off: no conversation is sent at all')

// The result is shown, with no write to the draft until the reader accepts.
const withResult = await settle('把那个 bug 修了')
assert.ok(textOf(withResult).includes('REWRITTEN'), 'the rewrite is shown')
assert.ok(textOf(withResult).includes('只是帮你把话说清楚'), 'the bar says sending is still the reader')
assert.equal(writes.length, 0, 'a result alone never touches the draft')

// 采用 writes the rewrite into the composer and nothing more.
buttonNamed(withResult, '采用').props.onClick()
assert.deepEqual(writes, ['REWRITTEN'], 'accepting writes the rewrite into the composer')

// 退回 restores the words exactly as they were before the rewrite.
writes.length = 0
const reverted = await (async () => {
  buttonNamed(drawBar('  原始的话  '), '帮我扩写').props.onClick()
  return settle('  原始的话  ')
})()
buttonNamed(reverted, '退回').props.onClick()
assert.deepEqual(writes, ['  原始的话  '], 'reverting restores the untouched original')

// 让它改: a follow-up instruction, and Enter there never sends the message.
writes.length = 0
posted.length = 0
buttonNamed(drawBar('  原始的话  '), '帮我扩写').props.onClick()
const settled = await settle('  原始的话  ')
buttonNamed(settled, '让它改').props.onClick()
const opened = drawBar('  原始的话  ')
const field = controlsOf(opened).find((node) => node.type === 'input')
assert.ok(field !== undefined, 'the change field appears')
assert.equal(field.props.type, 'text', 'the change field is plain text')
assert.ok(typeof field.props['aria-label'] === 'string' && field.props['aria-label'] !== '', 'the change field is labelled')
field.props.onChange({ target: { value: '再短一点' } })
const typed = controlsOf(drawBar('  原始的话  ')).find((node) => node.type === 'input')
posted.length = 0
let prevented = 0
let stopped = 0
typed.props.onKeyDown({
  key: 'Enter',
  nativeEvent: { isComposing: false },
  preventDefault: () => (prevented += 1),
  stopPropagation: () => (stopped += 1),
})
assert.equal(prevented, 1, 'Enter in the change field must not reach the composer')
assert.equal(stopped, 1, 'and must not bubble either')
assert.equal(posted.length, 1, 'Enter asks for one more rewrite')
assert.equal(posted[0].body.instruction, '再短一点', 'the change request rides along')
assert.equal(posted[0].body.text.trim(), '原始的话', 'the rewrite is redone from the original draft')
assert.equal(posted[0].body.previous, 'REWRITTEN', 'the last rewrite is the context for the change')
assert.equal(writes.length, 0, 'asking for a change never writes the draft')

// --- the conversation context switch ---------------------------------
// Off by default, and the switch must take effect on the very next run. The
// conversation is filled here so the transcript has something to carry.
// The cells are cleared first: earlier blocks leave the bar mid-rewrite, and a
// stale `busy` would hide the button this block needs to press.
hookState.length = 0
hookRefs.length = 0
{
  chatNodes = [
    { kind: 'user', visibility: 'visible', data: { role: 'user', content: [{ type: 'text', text: '把那个 bug 修了' }] } },
    { kind: 'assistant-step', visibility: 'visible', data: { blocks: [{ kind: 'text', text: '修好了，是登录页的空指针。' }] } },
    { kind: 'tool-call', visibility: 'visible', data: { root: { name: 'read', argsRaw: '{"file_path":"secret.ts"}' } } },
  ]
  globalThis.fetch = async (url, init = {}) => {
    posted.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ text: 'REWRITTEN' }) }
  }

  // Two buttons only: 不读 and 挑选聊天内容. The second one *is* the picker, so
  // there is no separate expander to find.
  const off = drawBar('把那个 bug 修了')
  assert.ok(textOf(off).includes('读取对话'), 'the bar names the setting')
  assert.ok(textOf(off).includes('不读'), 'and offers the first choice')
  assert.ok(textOf(off).includes('挑选聊天内容'), 'and the second')
  assert.ok(!textOf(off).includes('节选'), 'there is no preset window any more')
  assert.ok(!textOf(off).includes('选择段落'), 'and no separate expander either')
  assert.equal(controlsOf(off).find((node) => node.type === 'input' && node.props.type === 'checkbox'), undefined, 'on 不读 there is no message picker')

  posted.length = 0
  buttonNamed(drawBar('把那个 bug 修了'), '帮我扩写').props.onClick()
  await settleFresh('把那个 bug 修了')
  assert.ok(!('context' in posted[0].body), 'none: the request carries no conversation')

  // Switch to the whole conversation from the bar: the next run must carry it
  // at once, with the reader's ticks deciding what is inside.
  built.__test.setContext('full')
  const on = freshBar('把那个 bug 修了')
  assert.ok(textOf(on).includes('已选'), '挑选聊天内容 shows the inline list with its count')
  posted.length = 0
  buttonNamed(freshBar('把那个 bug 修了'), '帮我扩写').props.onClick()
  await settleFresh('把那个 bug 修了')
  const sent = posted[0].body
  assert.equal(typeof sent.context, 'string', 'full: the request carries the conversation')
  assert.ok(sent.context.includes('把那个 bug 修了'), 'including what the reader said')
  assert.ok(sent.context.includes('修好了，是登录页的空指针。'), 'and what the assistant replied')
  assert.ok(!sent.context.includes('secret.ts'), 'but never tool arguments')

  // Expanding shows the explanation, the counts, the per-message picker and the
  // payload itself.
  built.__test.setContext('full')
  // Remounted so the new mode is the initial state, then the drawer is opened.
  const opened = expandBar('把那个 bug 修了')
  assert.ok(textOf(opened).includes('默认全部勾选'), 'the picker explains its default')
  assert.ok(textOf(opened).includes('已选'), 'expanded: the counts are shown')
  assert.ok(textOf(opened).includes('未勾选的一律不发送'), 'expanded: the picker says unticked means unsent')
  assert.ok(!textOf(opened).includes('偏长'), 'a short selection gets no long-context warning')
  const boxes = controlsOf(opened).filter((node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(boxes.length, 2, 'one tick per readable message')
  assert.ok(boxes.every((node) => node.props.checked === true), 'all ticked by default in full mode')
  // The picker carries the message text itself, so there is no second preview
  // repeating it: what is ticked is exactly what is sent.
  assert.ok(textOf(opened).includes('把那个 bug 修了'), 'the picker shows the conversation text itself')

  // The list scrolls, so the newest message can sit below the fold: the jump
  // button must actually move it rather than just look like it would.
  {
    // The button shows only an arrow, so its label is what identifies it.
    const jump = controlsOf(opened).find(
      (node) => node.type === 'button' && node.props['aria-label'] === '回到最新一条',
    )
    assert.ok(jump !== undefined, 'the list offers a jump-to-bottom control')
    // One object stands in for both refs: the list element and the abort
    // controller, so the click path stays callable.
    const fake = { scrollTop: 0, scrollHeight: 999, abort() {} }
    hookRefs.forEach((ref) => { if (ref) ref.current = fake })
    jump.props.onClick()
    assert.equal(fake.scrollTop, 999, 'clicking it scrolls the list to its end')
  }

  // Unticking one message removes it from the request, and only it.
  boxes[0].props.onChange({ target: { checked: false } })
  const narrowed = drawBar('把那个 bug 修了')
  assert.equal(buttonNamed(narrowed, '恢复默认勾选') !== undefined, true, 'the reset shortcut is always available')
  posted.length = 0
  buttonNamed(narrowed, '帮我扩写').props.onClick()
  await settleFresh('把那个 bug 修了')
  assert.ok(!posted[0].body.context.includes('把那个 bug 修了'), 'the unticked message is not sent')
  assert.ok(posted[0].body.context.includes('修好了'), 'the rest still is')

  // Emptying the selection sends no conversation at all, and says so.
  buttonNamed(expandBar('把那个 bug 修了'), '清空').props.onClick()
  const emptied = expandBar('把那个 bug 修了')
  assert.ok(textOf(emptied).includes('未选任何对话'), 'an empty selection is reported, not hidden')
  posted.length = 0
  buttonNamed(emptied, '帮我扩写').props.onClick()
  await settleFresh('把那个 bug 修了')
  assert.ok(!('context' in posted[0].body), 'an empty selection sends no context key at all')

  // Restoring the default brings the preset back.
  buttonNamed(expandBar('把那个 bug 修了'), '恢复默认勾选').props.onClick()
  const restored = expandBar('把那个 bug 修了')
  const restoredBoxes = controlsOf(restored).filter((node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.ok(restoredBoxes.every((node) => node.props.checked === true), 'the default ticks come back')

  // Ticking all keeps the newest that fit and reports the cap.
  buttonNamed(expandBar('把那个 bug 修了'), '全选').props.onClick()
  const allTicked = expandBar('把那个 bug 修了')
  posted.length = 0
  buttonNamed(allTicked, '帮我扩写').props.onClick()
  await settleFresh('把那个 bug 修了')
  assert.ok(posted[0].body.context.length <= 1200, 'tick-all still respects the mode budget')

  // A non-contiguous pick: the two outer messages, not the one between them.
  {
    chatNodes = [
      { kind: 'user', visibility: 'visible', data: { role: 'user', content: [{ type: 'text', text: '第一段甲' }] } },
      { kind: 'assistant-step', visibility: 'visible', data: { blocks: [{ kind: 'text', text: '中间段乙' }] } },
      { kind: 'user', visibility: 'visible', data: { role: 'user', content: [{ type: 'text', text: '第三段丙' }] } },
    ]
    built.__test.setContext('full')
    hookState.length = 0
    hookRefs.length = 0
    const pick = expandBar('草稿')
    const pickBoxes = controlsOf(pick).filter((node) => node.type === 'input' && node.props.type === 'checkbox')
    assert.equal(pickBoxes.length, 3, 'all three readable messages are listed')
    assert.ok(pickBoxes.every((node) => node.props.checked === true), 'full mode ticks them all')
    // Untick the middle one, keeping the two ends: a cross-segment selection.
    pickBoxes[1].props.onChange({ target: { checked: false } })
    posted.length = 0
    buttonNamed(expandBar('草稿'), '帮我扩写').props.onClick()
    await settleFresh('草稿')
    const picked = posted[0].body.context
    assert.ok(picked.includes('第一段甲'), 'the first picked segment is sent')
    assert.ok(picked.includes('第三段丙'), 'the last picked segment is sent')
    assert.ok(!picked.includes('中间段乙'), 'the segment between them is not')
    assert.ok(picked.indexOf('第一段甲') < picked.indexOf('第三段丙'), 'segments keep their original order')
    chatNodes = []
  }

  // The Host transcript wins over the loaded node window, and the model's own
  // window decides the recommended size.
  {
    chatNodes = [
      { kind: 'user', visibility: 'visible', data: { role: 'user', content: [{ type: 'text', text: '窗口里的消息' }] } },
    ]
    built.__test.setContext('full')
    const history = {
      messages: [{ who: 'user', text: `只在宿主历史里的旧消息 ${'x'.repeat(1500)}` }],
      contextWindow: 2000,
    }
    const drawCard = () => {
      hookCursor = 0
      return mount(
        built.__test.RewriteCard({
          t,
          dock: 'dse-dock',
          text: '草稿',
          accept: () => {},
          background: (max) => built.__test.excerptOf(chatNodes, max),
          history,
        }),
      )
    }
    hookState.length = 0
    hookRefs.length = 0
    const withHistory = drawCard()
    assert.ok(textOf(withHistory).includes('只在宿主历史里的旧消息'), 'the drawer lists the Host transcript, not just the loaded window')
    assert.ok(!textOf(withHistory).includes('窗口里的消息'), 'and the loaded window is not mixed in')
    assert.ok(textOf(withHistory).includes('2000'), 'the model window is quoted back to the reader')
    assert.ok(textOf(withHistory).includes('1200'), 'with a recommended size derived from it')
    assert.ok(textOf(withHistory).includes('已经被压缩掉'), 'and the note says the list is the whole log')
  }

  // Nothing is trimmed: every ticked passage reaches the request, however long.
  {
    chatNodes = Array.from({ length: 40 }, (unused, index) => ({
      kind: index % 2 === 0 ? 'user' : 'assistant-step',
      visibility: 'visible',
      data: index % 2 === 0
        ? { role: 'user', content: [{ type: 'text', text: `第${index}段 ${'x'.repeat(800)}` }] }
        : { blocks: [{ kind: 'text', text: `第${index}段 ${'x'.repeat(800)}` }] },
    }))
    built.__test.setContext('full')
    hookState.length = 0
    hookRefs.length = 0
    const longBar = expandBar('草稿')
    assert.ok(textOf(longBar).includes('40/40'), 'the count shows every ticked passage, not a trimmed subset')
    assert.ok(textOf(longBar).includes('偏长'), 'a very long selection gets a non-blocking warning')
    assert.ok(textOf(longBar).includes('列表里只有聊天中已经加载出来的部分'), 'and the list explains what it can see')
    posted.length = 0
    buttonNamed(longBar, '帮我扩写').props.onClick()
    await settleFresh('草稿')
    const longSent = posted[0].body.context
    assert.ok(longSent.length > 24000, 'a long selection is not trimmed away')
    assert.ok(longSent.includes('第0段'), 'the oldest ticked passage is sent')
    assert.ok(longSent.includes('第39段'), 'and the newest')

    // Put the block's own conversation back for the checks that follow.
    chatNodes = [
      { kind: 'user', visibility: 'visible', data: { role: 'user', content: [{ type: 'text', text: '把那个 bug 修了' }] } },
      { kind: 'assistant-step', visibility: 'visible', data: { blocks: [{ kind: 'text', text: '修好了，是登录页的空指针。' }] } },
      { kind: 'tool-call', visibility: 'visible', data: { root: { name: 'read', argsRaw: '{"file_path":"secret.ts"}' } } },
    ]
    built.__test.setContext('full')
  }

  // Turning it back off takes effect on the next run, with no reload.
  built.__test.setContext('off')
  posted.length = 0
  buttonNamed(freshBar('把那个 bug 修了'), '帮我扩写').props.onClick()
  await settleFresh('把那个 bug 修了')
  assert.ok(!('context' in posted[0].body), 'turning it off again stops sending the conversation')

  // Consecutive runs keep following the mode, in both directions.
  built.__test.setContext('full')
  posted.length = 0
  buttonNamed(freshBar('把那个 bug 修了'), '帮我扩写').props.onClick()
  await settleFresh('把那个 bug 修了')
  buttonNamed(freshBar('把那个 bug 修了'), '帮我扩写').props.onClick()
  await settleFresh('把那个 bug 修了')
  assert.equal(posted.length, 2, 'two runs, two requests')
  assert.ok(posted.every((each) => typeof each.body.context === 'string'), 'both runs carry the conversation')

  // The transcript keeps the newest that fit and reports what it dropped.
  const many = Array.from({ length: 40 }, (unused, index) => ({
    kind: index % 2 === 0 ? 'user' : 'assistant-step',
    visibility: 'visible',
    data: { role: 'user', content: [{ type: 'text', text: `第${index}条 ${'x'.repeat(200)}` }] },
  }))
  const cut = built.__test.excerptOf(many, 1200)
  assert.ok(cut.text.length <= 1200, 'the excerpt respects its budget')
  assert.ok(cut.text.includes('第39条'), 'the newest exchange is kept')
  assert.ok(!cut.text.includes('第0条'), 'and the oldest is dropped')
  assert.ok(cut.dropped > 0, 'the dropped count is reported')
  // The list is the whole conversation; the preset is a subset of it, so what
  // is on screen to pick from is never narrowed by the budget.
  assert.equal(cut.items.length, 40, 'every readable message is listed, not just the preset')
  assert.equal(cut.auto.size + cut.dropped, 40, 'preset plus dropped is the whole conversation')
  assert.ok(cut.auto.size > 0, 'the preset ticks something')
  assert.ok(cut.items.every((item) => typeof item.key === 'string' && item.key !== ''), 'every message has a stable key')
  assert.equal(new Set(cut.items.map((item) => item.key)).size, 40, 'keys are unique')

  // Hidden nodes never reach the transcript.
  assert.ok(
    !built.__test.transcriptOf([{ kind: 'user', visibility: 'hidden', data: { role: 'user', content: [{ type: 'text', text: '隐藏的话' }] } }], 4000).includes('隐藏的话'),
    'a hidden node is not part of the context',
  )

  // Only `text` blocks count. An assistant step also carries reasoning, which is
  // not conversation the reader would recognise, so it must not leak into the
  // rewrite prompt.
  {
    const mixed = [
      { kind: 'user', visibility: 'visible', data: { role: 'user', content: [{ type: 'text', text: '可见提问' }] } },
      {
        kind: 'assistant-step',
        visibility: 'visible',
        data: {
          blocks: [
            { kind: 'reasoning', text: '内部推理不要发送' },
            { kind: 'text', text: '可见回答' },
          ],
        },
      },
    ]
    const picked = built.__test.excerptOf(mixed, 4000)
    assert.ok(picked.text.includes('可见提问'), 'the user message is read from data.content')
    assert.ok(picked.text.includes('可见回答'), 'the assistant text block is read from data.blocks')
    assert.ok(!picked.text.includes('内部推理'), 'reasoning blocks never become context')
    assert.equal(picked.items.length, 2, 'both messages are listed')
  }

  // Injected project instructions carry a role that is not the reader's own
  // voice, so they stay out of the transcript.
  {
    const injected = built.__test.excerptOf([
      { kind: 'user', visibility: 'visible', data: { role: 'constraint', content: [{ type: 'text', text: '项目约定' }] } },
      { kind: 'user', visibility: 'visible', data: { role: 'user', content: [{ type: 'text', text: '我的问题' }] } },
    ], 4000)
    assert.ok(!injected.text.includes('项目约定'), 'a constraint is not the reader speaking')
    assert.ok(injected.text.includes('我的问题'), 'their own message still is')
  }

  chatNodes = []
  built.__test.setContext('off')
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({ text: '' }) })
posted.length = 0
assert.equal(await built.__test.fetchRewrite({ text: '原始的话', tone: 'detailed', lang: 'zh' }), '', 'an empty answer is no rewrite')
const failed = drawBar('原始的话')
const retry = controlsOf(failed).find((node) => node.type === 'button' && node.props.disabled !== true && textOf(node).includes('扩写'))
retry.props.onClick()
const afterFail = await settle('原始的话')
assert.ok(textOf(afterFail).includes('这次没改成功'), 'a failed rewrite is reported')
assert.ok(!textOf(afterFail).includes('采用'), 'a failed rewrite offers nothing to accept')
assert.equal(writes.length, 0, 'a failed rewrite never touches the draft')

// A failed REVISION must keep the version the reader already had. Losing it
// means losing the rewrite they were about to accept, and the only way back is
// to start the whole thing again.
{
  hookState.length = 0
  hookRefs.length = 0
  posted.length = 0
  let calls = 0
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) })
    calls += 1
    return calls === 1
      ? { ok: true, json: async () => ({ text: '第一版' }) }
      : { ok: false, json: async () => ({ text: '' }) }
  }
  buttonNamed(drawBar('原始的话'), '帮我扩写').props.onClick()
  const kept = await settle('原始的话')
  assert.ok(textOf(kept).includes('第一版'), 'the first rewrite landed')

  buttonNamed(kept, '让它改').props.onClick()
  const askField = controlsOf(drawBar('原始的话')).find((node) => node.type === 'input')
  askField.props.onChange({ target: { value: '再短一点' } })
  buttonNamed(drawBar('原始的话'), '改一版').props.onClick()
  const afterFailedChange = await settle('原始的话')

  assert.equal(posted.length, 2, 'the change was actually sent')
  assert.equal(posted[1].body.previous, '第一版', 'and it carried the previous version')
  assert.ok(textOf(afterFailedChange).includes('第一版'), 'a failed change keeps the previous rewrite on screen')
  assert.ok(textOf(afterFailedChange).includes('采用'), 'so the reader can still accept it')
  assert.ok(textOf(afterFailedChange).includes('上一版还在'), 'and is told the previous version survived')
  assert.ok(!textOf(afterFailedChange).includes('这次没改成功'), 'it is not reported as a total failure')
  assert.equal(writes.length, 0, 'a failed change never touches the draft')
}

// --- the question card's answer box -----------------------------------
// A live `ask_user_question` card replaces the composer, so the dock is gone
// while the reader is answering. The same panel is anchored to the card from
// the frame overlay; these checks pin the two things it must get right: find
// the box, and write into it the way typing would.
{
  // A minimal stand-in for the card's markup: the root carries the key, the box
  // is a textarea, and a settled card leaves the box disabled.
  const textarea = (disabled = false) => ({
    disabled,
    value: '',
    closest: () => card,
    dispatchEvent: (event) => events.push(event.type),
  })
  const events = []
  let card = { getBoundingClientRect: () => ({ left: 100, width: 600, top: 200 }) }
  const doc = { querySelectorAll: () => fields }
  let fields = []
  globalThis.document = doc
  globalThis.innerHeight = 800

  fields = []
  assert.equal(built.__test.questionSeat(doc), null, 'no card: nothing to anchor to')

  fields = [textarea()]
  const seat = built.__test.questionSeat(doc)
  assert.equal(seat.field, fields[0], 'the enabled box is the one the reader types in')
  assert.equal(seat.card, card, 'and its card is what the panel is placed against')

  // A settled card disables its box; a disabled box must never be rewritten.
  fields = [textarea(true)]
  assert.equal(built.__test.questionSeat(doc), null, 'a disabled box is not a live answer seat')

  // Writing goes through the native setter and a bubbling input event, which is
  // how a React controlled textarea learns a value it did not type. The setter
  // lives on the element's prototype, exactly where a real textarea keeps it.
  const field = textarea()
  const proto = Object.getPrototypeOf(field)
  let setterCalls = 0
  Object.defineProperty(proto, 'value', {
    configurable: true,
    get: () => '',
    set: () => {
      setterCalls += 1
    },
  })
  assert.equal(built.__test.writeAnswer(field, '写清楚的答案'), true, 'the write happens')
  assert.equal(setterCalls, 1, 'the native value setter is used, bypassing React’s tracker')
  assert.deepEqual(events, ['input'], 'and one input event tells React the value changed')
  delete proto.value

  // The panel never claims a conversation it cannot read: the card is outside
  // the chat, so its card carries no context switch and no context key.
  built.__test.setContext('full')
  hookState.length = 0
  hookRefs.length = 0
  const questionBar = mount(built.__test.RewriteCard({ text: '含糊的回答', accept: () => {}, dock: 'dse-float', t }))
  assert.ok(textOf(questionBar).includes('帮我扩写'), 'the panel still offers a rewrite')
  assert.ok(!textOf(questionBar).includes('读取对话'), 'and shows no mode row it could not honour')
  built.__test.setContext('off')

  delete globalThis.document
  delete globalThis.innerHeight
}

// A dead network is the same story, not a crash.
globalThis.fetch = async () => {
  throw new Error('offline')
}
assert.equal(await built.__test.fetchRewrite({ text: 'x', tone: 'detailed', lang: 'zh' }), '', 'a dead network yields no rewrite')
assert.equal(await built.__test.fetchRewrite({ text: 'x', tone: 'concise', lang: 'zh' }), '')
delete globalThis.fetch

// --- registration -----------------------------------------------------
// `apply` is what the shell actually runs, so assert what it claims: five
// read-only surfaces plus the new Settings page, and nothing that answers an
// approval. A stub ctx records every registration.
const registered = []
const stubCtx = {
  effect: (fn) => fn(),
  locale: { register: () => {}, bind: () => t },
  get: () => undefined,
  slots: {
    inject: (name, fn) => fn(),
    register: (options, component) => {
      registered.push({ ...options, component })
      return () => {}
    },
  },
}
built.apply(stubCtx)
const slotNames = registered.map((entry) => entry.name)
assert.deepEqual(
  [...new Set(slotNames)].sort(),
  ['conversation.approval.detail', 'conversation.chat.turnTail', 'conversation.input.dock', 'settings.general.item', 'settings.section', 'shell.overlay'],
  'the plugin registers the four surfaces, both settings seats and the question-card overlay',
)
const section = registered.find((entry) => entry.name === 'settings.section')
assert.equal(section.id, 'step-explain', 'the Settings page has its own id')
assert.equal(section.component, built.__test.SettingsPage, 'and renders the page')
assert.equal(typeof section.label, 'function', 'the nav label is a thunk, so it follows the locale')
assert.equal(section.label(), '步骤说明', 'the nav label is localized')
const generalItem = registered.find((entry) => entry.name === 'settings.general.item')
assert.equal(generalItem.id, 'step-explain', 'the General row is unchanged and still registered')
assert.equal(generalItem.order, 95, 'and keeps its position')
// The dock cells keep their distinct ids so neither replaces the other.
const dockIds = registered.filter((entry) => entry.name === 'conversation.input.dock').map((entry) => entry.id)
assert.deepEqual(dockIds, ['step-explain-welcome', 'step-explain', 'step-explain-rewrite'], 'the three dock cells keep separate ids')
// No surface registered here can answer an approval.
assert.ok(
  registered.every((entry) => entry.name !== 'conversation.approval.action'),
  'nothing registers an approval answer',
)
// The question card's panel is its own overlay cell, and it still cannot answer
// anything: it writes into a text box the reader then submits themselves.
const overlay = registered.find((entry) => entry.name === 'shell.overlay')
assert.equal(overlay.id, 'step-explain-question', 'the overlay cell has its own id')
assert.equal(overlay.component, built.__test.QuestionRewrite, 'and renders the question-card panel')
assert.ok(
  registered.every((entry) => entry.name !== 'conversation.composer'),
  'the question card is never taken over: the plugin only adds a panel above it',
)

// --- the one-time welcome --------------------------------------------
// It fires the first time the plugin runs in a browser profile, which is the
// closest thing the client has to "just installed and enabled".
{
  const welcomeStore = new Map()
  globalThis.localStorage = {
    getItem: (key) => welcomeStore.get(key) ?? null,
    setItem: (key, value) => welcomeStore.set(key, value),
  }
  assert.equal(built.__test.readWelcomed(), false, 'a fresh profile has not dismissed the welcome')

  const welcome = render(built.__test.Welcome, {})
  const text = textOf(welcome)
  assert.ok(text.includes('步骤解释已开启'), 'the welcome says what was turned on')
  assert.ok(text.includes('输入框上方'), 'and names the first surface')
  assert.ok(text.includes('每轮说完'), 'the second')
  assert.ok(text.includes('弹出审批框'), 'the third')
  const dismiss = buttonNamed(welcome, '知道了')
  assert.ok(dismiss !== undefined, 'and it can be dismissed')

  dismiss.props.onClick()
  assert.equal(welcomeStore.get('dsh-step-explain/welcome'), 'done', 'dismissing is remembered for the profile')
  assert.equal(built.__test.readWelcomed(), true, 'and reads back as dismissed')
  assert.equal(render(built.__test.Welcome, {}), null, 'it never renders again')

  delete globalThis.localStorage
}

// --- picking a run of messages ---------------------------------------
// The toggle changes what one click means; Shift closes a range. Both act on
// the same rows, so they are checked against one five-message conversation.
{
  chatNodes = Array.from({ length: 5 }, (unused, index) => ({
    kind: index % 2 === 0 ? 'user' : 'assistant-step',
    visibility: 'visible',
    data: index % 2 === 0
      ? { role: 'user', content: [{ type: 'text', text: `第${index}条` }] }
      : { blocks: [{ kind: 'text', text: `第${index}条` }] },
  }))
  built.__test.setContext('full')
  const boxesOf = (tree) => controlsOf(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox')

  const bar = freshBar('草稿')
  assert.equal(
    buttonNamed(bar, '点一条选到最新').props['aria-pressed'],
    false,
    'the run-to-newest mode starts off',
  )

  // Off: a click ticks exactly one message.
  buttonNamed(bar, '清空').props.onClick()
  boxesOf(drawBar('草稿'))[1].props.onChange({ target: { checked: true } })
  assert.ok(textOf(drawBar('草稿')).includes('已选 1/5'), 'off: one click ticks one message')

  // On: with nothing ticked, a click runs to the newest.
  buttonNamed(drawBar('草稿'), '点一条选到最新').props.onClick()
  const on = drawBar('草稿')
  assert.equal(
    buttonNamed(on, '点一条选到最新').props['aria-pressed'],
    true,
    'the button shows the mode is on',
  )
  buttonNamed(on, '清空').props.onClick()
  boxesOf(drawBar('草稿'))[1].props.onChange({ target: { checked: true } })
  assert.ok(textOf(drawBar('草稿')).includes('已选 4/5'), 'on: the click runs from there to the newest')

  // Off again: a click stays a single message even with nothing ticked.
  buttonNamed(drawBar('草稿'), '点一条选到最新').props.onClick()
  buttonNamed(drawBar('草稿'), '清空').props.onClick()
  boxesOf(drawBar('草稿'))[2].props.onChange({ target: { checked: true } })
  assert.ok(textOf(drawBar('草稿')).includes('已选 1/5'), 'off again: back to one message per click')

  // Shift closes the range between the anchor and the clicked message.
  buttonNamed(drawBar('草稿'), '清空').props.onClick()
  boxesOf(drawBar('草稿'))[0].props.onChange({ target: { checked: true } })
  const row = controlsOf(drawBar('草稿')).filter((node) => node.type === 'label' && node.props.className === 'dse-context-item')[2]
  let prevented = false
  row.props.onClick({ shiftKey: true, preventDefault: () => { prevented = true } })
  assert.ok(prevented, 'a Shift click does not let the box flip itself')
  assert.ok(textOf(drawBar('草稿')).includes('已选 3/5'), 'Shift selects the range between the two ends')

  chatNodes = []
  built.__test.setContext('off')
}

// --- the fixes that keep the picker honest -----------------------------
// A session switch must not carry ticks across; the Host must not be asked for
// a transcript the reader said not to read; an oversized pick must say so.
{
  const history = {
    messages: [
      { who: 'user', text: '会话甲的第一条' },
      { who: 'assistant', text: '会话甲的回复' },
    ],
  }
  const own = built.__test.buildPickContext({
    mode: 'full',
    picked: { 's1#0:user': false },
    history,
    fallbackItems: [],
    scope: 's1',
  })
  assert.equal(own.chosen.length, 1, 'a tick turned off in its own session stays off')

  const other = built.__test.buildPickContext({
    mode: 'full',
    picked: { 's1#0:user': false },
    history,
    fallbackItems: [],
    scope: 's2',
  })
  assert.equal(other.chosen.length, 2, 'another session never inherits that tick')
  assert.ok(
    other.items.every((item) => item.key.startsWith('s2#')),
    'keys are scoped to the session that produced them',
  )

  assert.equal(built.__test.shouldReadTranscript('s1', false), false, 'do-not-read never fetches')
  assert.equal(built.__test.shouldReadTranscript('s1', true), true, 'asking to read does fetch')
  assert.equal(built.__test.shouldReadTranscript('', true), false, 'no session, nothing to fetch')
  assert.equal(built.__test.shouldReadTranscript(undefined, true), false, 'a missing session is not fetched')

  const loaded = { sessionId: 's1', history: { messages: [{ who: 'user', text: '甲的对话' }] } }
  assert.equal(built.__test.historyFor(loaded, 's1'), loaded.history, 'a transcript is reused for its own session')
  assert.equal(built.__test.historyFor(loaded, 's2'), undefined, 'and never for a different one')
  assert.equal(built.__test.historyFor(undefined, 's1'), undefined, 'nothing loaded means nothing to reuse')

  // The bar must survive being handed a session: that is what wires the card to
  // the transcript fetch and to the session-scoped keys.
  built.__test.setContext('off')
  hookState.length = 0
  hookRefs.length = 0
  const withSession = mount(
    built.__test.RewriteBar({
      t,
      sessionId: 's1',
      useInput: (select) => select({ draft: '草稿' }),
      useChat: (select) => select({ nodes: { values: () => [] }, legacy: { nodes: [] } }),
      inputActions,
    }),
  )
  assert.ok(textOf(withSession).includes('把这句话写清楚'), 'the bar still renders with a session id')
}

// Over the Host's limit the card says so instead of pretending it all goes out.
{
  built.__test.setContext('full')
  hookState.length = 0
  hookRefs.length = 0
  const long = 'x'.repeat(1_000_100)
  const tree = mount(
    built.__test.RewriteCard({
      t,
      dock: 'dse-dock',
      text: '草稿',
      accept: () => {},
      background: () => [],
      history: { messages: [{ who: 'user', text: long }], contextWindow: 64000 },
    }),
  )
  assert.ok(textOf(tree).includes('100 万字符'), 'a payload over the Host limit is called out')
  built.__test.setContext('off')
}

console.log('dsh-step-explain: all self-checks passed')
