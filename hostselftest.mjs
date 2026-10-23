// Self-check for dsh-step-explain's Host half. No dependency, no network:
//   node hostselftest.mjs
import assert from 'node:assert/strict'
import { apply, clean, cleanRewrite, parseInput, parseRewrite } from './index.js'

// --- parsing at the wire ---------------------------------------------
assert.deepEqual(parseInput({ name: 'read', argsRaw: '{"file_path":"a"}' }), {
  name: 'read',
  argsRaw: '{"file_path":"a"}',
  lang: 'en',
  study: 'now',
})
assert.deepEqual(parseInput({ name: 'read', argsRaw: 'x', lang: 'zh-CN' }).lang, 'zh')
// The study level reaches the Host and is validated, so the prompt can follow it.
assert.equal(parseInput({ name: 'read', argsRaw: 'x', study: 'plan' }).study, 'plan', 'a known level is kept')
assert.equal(parseInput({ name: 'read', argsRaw: 'x', study: 'why' }).study, 'why')
assert.equal(parseInput({ name: 'read', argsRaw: 'x', study: 'nonsense' }), undefined, 'an unknown level is refused')
assert.deepEqual(parseInput({ name: 'read', lang: 'fr' }).lang, 'en', 'an unknown language falls back to English')
assert.equal(parseInput({ name: 'read' }).argsRaw, '', 'missing arguments are an empty string')

for (const bad of [undefined, null, [], 'text', 7, {}, { name: '' }, { name: '  ' }, { name: 7 }, { name: 'read', argsRaw: 5 }]) {
  assert.equal(parseInput(bad), undefined, `accepted invalid body ${JSON.stringify(bad)}`)
}

// Bounds: a huge name or argument text is clipped, never forwarded whole.
assert.equal(parseInput({ name: 'x'.repeat(500), argsRaw: 'y'.repeat(5000) }).name.length, 120)
assert.equal(parseInput({ name: 'read', argsRaw: 'y'.repeat(5000) }).argsRaw.length, 2000)

// --- model output ----------------------------------------------------
assert.equal(clean('  两行\n\n文本  '), '两行 文本')
assert.equal(clean(undefined), '')
assert.equal(clean(null), '')
assert.equal(clean(''), '')
const long = clean('z'.repeat(2000))
assert.ok(long.length <= 600, 'a runaway answer is clipped')
assert.ok(long.endsWith('…'), 'a clipped answer says so')

// --- the route -------------------------------------------------------
const routes = []
let answer = '这一步会运行项目的测试。'
let answerThrows = false
const ctx = {
  // A real Connection registers the route inside `owner.effect`; the stub only
  // records it, so this test proves the call shape rather than the lifetime.
  effect: (fn) => fn(),
  inject: (deps, fn) => fn(ctx),
  // Only `agentDefaultModel` is read late, through `get`, so a profile without
  // it degrades instead of failing the whole registration.
  get: (key) => (key === 'agentDefaultModel' ? ctx.agentDefaultModel : undefined),
  connection: {
    fetch: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  },
  llm: {
    prepareCall: async () => ({
      config: { provider: 'p', model: 'm', maxTokens: 200 },
      async *stream() {
        if (answerThrows) throw new Error('provider down')
        yield { type: 'reasoning-delta', text: 'ignored' }
        yield { type: 'text-delta', text: answer.slice(0, 3) }
        yield { type: 'text-delta', text: answer.slice(3) }
        yield { type: 'finish' }
      },
    }),
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
}
apply(ctx)

assert.equal(routes.length, 3, 'all three routes are registered')
const route = routes.find((r) => r.path === '/api/step-explain.detail')
const rewriteRoute = routes.find((r) => r.path === '/api/step-explain.rewrite')
const modelRoute = routes.find((r) => r.path === '/api/step-explain.model')
assert.ok(route !== undefined && rewriteRoute !== undefined && modelRoute !== undefined, 'detail, rewrite and model all exist')
for (const each of [route, rewriteRoute]) {
  assert.deepEqual([...each.methods], ['POST'])
  assert.equal(each.requestBody, 'buffered')
}
assert.deepEqual([...modelRoute.methods], ['GET', 'PUT'], 'the model route reads and writes')

/** Post one body the way the page does. */
const post = (body, headers = { 'content-type': 'application/json' }) =>
  route.fetch(new Request('http://host/api/step-explain.detail', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }))

const ok = await post({ name: 'pwsh', argsRaw: '{"command":"npm test"}', lang: 'zh' })
assert.equal(ok.status, 200)
assert.deepEqual(await ok.json(), { detail: '这一步会运行项目的测试。' }, 'reasoning deltas are not shown')

// The answer language reaches the prompt, and the arguments are bounded.
let seen
ctx.llm.prepareCall = async (config) => {
  seen = config
  return {
    config,
    async *stream() {
      if (answerThrows) throw new Error('provider down')
      yield { type: 'text-delta', text: 'x' }
    },
  }
}
await post({ name: 'read', argsRaw: '{"file_path":"a"}', lang: 'zh' })
assert.deepEqual(seen, { provider: 'p', model: 'm', maxTokens: 200 })

// Every kind of failure still answers 200 with no detail, so the Client keeps its rules.
answerThrows = true
const failed = await post({ name: 'read', argsRaw: '{}' })
assert.equal(failed.status, 200)
assert.deepEqual(await failed.json(), { detail: '' }, 'a provider failure explains nothing rather than erroring')

ctx.llm.prepareCall = async () => {
  throw new Error('no route')
}
const unrouteable = await post({ name: 'read', argsRaw: '{}' })
assert.equal(unrouteable.status, 200)
assert.deepEqual(await unrouteable.json(), { detail: '' }, 'no model configured is not a crash')

// Bad requests are refused before any model call.
assert.equal((await post('<not json>')).status, 400)
assert.equal((await post({ name: '' })).status, 400)
assert.equal((await post({ name: 'read' }, { 'content-type': 'text/plain' })).status, 415)

// A missing default route is a configuration error, not a per-request one.
ctx.agentDefaultModel.currentSelection = () => undefined
const lost = await post({ name: 'read', argsRaw: '{}' })
assert.equal(lost.status, 200, 'even a broken default route degrades to no detail')

// --- an explicitly configured model ----------------------------------
// `config.provider`/`config.model` win over the chat default, so the detail
// paragraph can be written by a cheaper or local model.
const pinned = []
const pinnedCalls = []
const pinnedCtx = {
  effect: (fn) => fn(),
  inject: (deps, fn) => (pinned.push([...deps]), fn(pinnedCtx)),
  get: () => undefined,
  connection: { fetch: { register: (route) => (pinned.push(route), () => {}) } },
  llm: {
    prepareCall: async (config) => {
      pinnedCalls.push(config)
      return { config, async *stream() { yield { type: 'text-delta', text: 'ok' } } }
    },
  },
  // Deliberately absent: a pinned route must not need the chat default.
  agentDefaultModel: undefined,
}
apply(pinnedCtx, { provider: 'local', model: 'tiny' })
assert.deepEqual(pinned[0], ['connection', 'llm'], 'the chat default is never a hard dependency')
const pinnedDetail = pinned.find((entry) => entry?.path === '/api/step-explain.detail')
assert.ok(pinnedDetail !== undefined, 'the detail route is registered')
const pinnedAnswer = await pinnedDetail.fetch(
  new Request('http://host/api/step-explain.detail', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'read', argsRaw: '{}' }),
  }),
)
assert.deepEqual(await pinnedAnswer.json(), { detail: 'ok' })
assert.deepEqual(
  { provider: pinnedCalls[0].provider, model: pinnedCalls[0].model },
  { provider: 'local', model: 'tiny' },
  'the configured model is used instead of the chat default',
)

// The study level shapes the prompt, so a model-written explanation carries the
// same parts the rule text does. All three must differ, or the level is inert.
{
  const systems = []
  const tokens = []
  for (const study of ['now', 'why', 'plan']) {
    let seen
    pinnedCtx.llm.prepareCall = async (config) => {
      tokens.push(config.maxTokens)
      return {
        config,
        async *stream(request) {
          seen = request
          yield { type: 'text-delta', text: 'ok' }
        },
      }
    }
    await pinnedDetail.fetch(
      new Request('http://host/api/step-explain.detail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'read', argsRaw: '{}', lang: 'zh', study }),
      }),
    )
    assert.ok(seen !== undefined, `the "${study}" level reaches the model`)
    systems.push(seen.system)
  }
  assert.equal(new Set(systems).size, 3, 'each study level asks the model for a different explanation')
  assert.ok(!systems[1].includes('下一步'), 'the why level does not ask for the next step')
  assert.ok(systems[2].includes('下一步'), 'the plan level does')
  assert.ok(tokens[2] >= tokens[0], 'a fuller level is not given less room than the shortest')
  // An absent level behaves like the shortest one, so old callers keep working.
  let plain
  pinnedCtx.llm.prepareCall = async (config) => ({
    config,
    async *stream(request) {
      plain = request
      yield { type: 'text-delta', text: 'ok' }
    },
  })
  await pinnedDetail.fetch(
    new Request('http://host/api/step-explain.detail', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read', argsRaw: '{}', lang: 'zh' }),
    }),
  )
  assert.equal(plain.system, systems[0], 'no level means the plain one-liner prompt')
}

// A half-configured route falls back to the chat default instead of failing.
const half = []
const halfCalls = []
const halfCtx = {
  effect: (fn) => fn(),
  inject: (deps, fn) => (half.push([...deps]), fn(halfCtx)),
  get: (key) => (key === 'agentDefaultModel' ? halfCtx.agentDefaultModel : undefined),
  connection: { fetch: { register: (route) => (half.push(route), () => {}) } },
  llm: { prepareCall: async (config) => (halfCalls.push(config), { config, async *stream() { yield { type: 'text-delta', text: 'x' } } }) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'chat', model: 'big' }) },
}
apply(halfCtx, { provider: 'local' })
assert.deepEqual(half[0], ['connection', 'llm'], 'an incomplete pin registers the same way')
await half.find((entry) => entry?.path === '/api/step-explain.detail').fetch(
  new Request('http://host/api/step-explain.detail', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'read', argsRaw: '{}' }),
  }),
)
assert.deepEqual({ provider: halfCalls[0].provider, model: halfCalls[0].model }, { provider: 'chat', model: 'big' })

// The reader's own choice in Settings outranks both.
const chosen = []
const chosenCalls = []
const chosenRoutes = []
const chosenCtx = {
  effect: (fn) => fn(),
  inject: (deps, fn) => fn(chosenCtx),
  get: (key) => (key === 'agentDefaultModel' ? chosenCtx.agentDefaultModel : undefined),
  connection: { fetch: { register: (route) => (chosenRoutes.push(route), () => {}) } },
  llm: { prepareCall: async (config) => (chosenCalls.push(config), { config, async *stream() { yield { type: 'text-delta', text: 'x' } } }) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'chat', model: 'big' }) },
}
apply(chosenCtx, { provider: 'local', model: 'tiny' })
await chosenRoutes.find((entry) => entry?.path === '/api/step-explain.detail').fetch(
  new Request('http://host/api/step-explain.detail', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'read', argsRaw: '{}', model: { provider: 'mine', model: 'small' } }),
  }),
)
assert.deepEqual(
  { provider: chosenCalls[0].provider, model: chosenCalls[0].model },
  { provider: 'mine', model: 'small' },
  "the reader's Settings choice beats the profile pin",
)

assert.deepEqual(
  parseInput({ name: 'read', model: { provider: 'mine', model: 'small' } }).model,
  { provider: 'mine', model: 'small' },
  'the reader model survives validation',
)
assert.equal(parseInput({ name: 'read', model: { provider: '', model: 'x' } }), undefined, 'a half model is a bad request')
assert.equal(parseInput({ name: 'read', model: { provider: 'p' } }), undefined)
assert.equal(parseInput({ name: 'read', model: 'p/m' }), undefined, 'the model must be a pair, not a string')
assert.equal(parseInput({ name: 'read', model: null }), undefined)
assert.equal(parseInput({ name: 'read', model: { provider: 'p', model: 'x'.repeat(500) } }).model.model.length, 120)

// --- rewriting a rough instruction ------------------------------------
const postRewrite = (body, headers = { 'content-type': 'application/json' }) =>
  rewriteRoute.fetch(
    new Request('http://host/api/step-explain.rewrite', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

let rewriteSeen
let rewritePrompt
// Restore the default route the earlier failure test removed.
ctx.agentDefaultModel.currentSelection = () => ({ provider: 'p', model: 'm' })
ctx.llm.prepareCall = async (config) => {
  rewriteSeen = config
  return {
    config,
    async *stream(request) {
      // Overwrite, not `??=`: the tone tests below each need their own prompt.
      rewritePrompt = request
      yield { type: 'text-delta', text: '改写后的指令。' }
    },
  }
}
const rewritten = await postRewrite({ text: '  把那个 bug 修了  ', tone: 'concise', lang: 'zh' })
assert.equal(rewritten.status, 200)
assert.deepEqual(await rewritten.json(), { text: '改写后的指令。' })
assert.equal(rewriteSeen.maxTokens, 1200, 'a rewrite gets room for a whole instruction')
assert.equal(rewriteSeen.provider, 'p')
assert.ok(rewritePrompt?.system.includes('尽量短'), 'the concise tone reaches the prompt')

// The request body: the draft, then the previous version, then the change.
let prompt
ctx.llm.prepareCall = async (config) => ({
  config,
  async *stream() {
    yield { type: 'text-delta', text: 'x' }
  },
})
const seenMessages = []
const originalStream = ctx.llm.prepareCall
ctx.llm.prepareCall = async (config) => {
  const call = await originalStream(config)
  return {
    config: call.config,
    async *stream(request) {
      seenMessages.push(request)
      yield* call.stream()
    },
  }
}
await postRewrite({ text: '修 bug', previous: '修一下 bug', instruction: '短一点', lang: 'zh' })
prompt = seenMessages[0]
assert.ok(prompt.system.includes('改写'), 'the system prompt states the rewriting job')
assert.ok(prompt.system.includes('写得详细些'), 'the default tone is thorough')
const body = prompt.messages[0].content[0].text
assert.ok(body.startsWith('修 bug'), 'the current draft leads the prompt')
assert.ok(body.includes('[上一版]\n修一下 bug'), 'the previous rewrite is labelled, not obeyed')
assert.ok(body.includes('[这次的修改要求] 短一点'), 'the change request is labelled too')

// Cleanup of model output: fences, prefixes and blank-line runs go; a list stays.
assert.equal(cleanRewrite('```\n改写后：跑测试\n```'), '跑测试')
assert.equal(cleanRewrite('Rewritten: run the tests'), 'run the tests')
assert.equal(cleanRewrite('  a  \n\n\n  b  '), 'a\n\nb')
assert.equal(cleanRewrite('- one\n- two'), '- one\n- two', 'a list keeps its lines')
assert.equal(cleanRewrite(undefined), '')
assert.ok(cleanRewrite('z'.repeat(9000)).length <= 4000, 'a runaway rewrite is clipped')

// Validation at the wire.
assert.equal((await postRewrite('<not json>')).status, 400)
assert.equal((await postRewrite({ text: '' })).status, 400)
assert.equal((await postRewrite({ text: '   ' })).status, 400)
assert.equal((await postRewrite({ text: 7 })).status, 400)
assert.equal((await postRewrite({ text: 'x', tone: 'rude' })).status, 400, 'an unknown tone is refused')
// All three length levels are accepted, and each reaches the prompt differently.
// Install the stub here: earlier blocks replace `prepareCall`, so a test relying
// on one of theirs would silently pass with no model call happening at all.
const tonePrompts = []
for (const [tone, marker] of [
  ['concise', '尽量短'],
  ['balanced', '长度适中'],
  ['detailed', '写得详细些'],
]) {
  let seen
  ctx.llm.prepareCall = async (config) => ({
    config,
    async *stream(request) {
      seen = request
      yield { type: 'text-delta', text: '改好的指令' }
    },
  })
  const response = await postRewrite({ text: '修那个 bug', tone, lang: 'zh' })
  assert.equal(response.status, 200, `"${tone}" is a valid level`)
  assert.equal((await response.json()).text, '改好的指令', `"${tone}" produces a rewrite`)
  assert.ok(seen !== undefined, `"${tone}" actually reaches the model`)
  assert.ok(seen.system.includes(marker), `the "${tone}" level shapes the prompt`)
  tonePrompts.push(seen.system)
}
// The three prompts must differ from one another, not merely parse.
assert.equal(new Set(tonePrompts).size, 3, 'each level asks the model for a different shape')
assert.equal(parseRewrite({ text: 'x', tone: 'balanced' }).tone, 'balanced', 'the middle level survives parsing')
assert.notEqual(parseRewrite({ text: 'x', tone: 'balanced' }).tone, 'detailed', 'and is not folded into the fullest level')
assert.equal((await postRewrite({ text: 'x', model: 'p/m' })).status, 400)
assert.equal((await postRewrite({ text: 'x', previous: 7 })).status, 400)
assert.equal((await postRewrite({ text: 'x', instruction: 7 })).status, 400)
assert.equal((await postRewrite({ text: 'x' }, { 'content-type': 'text/plain' })).status, 415)
assert.equal(parseRewrite({ text: 'x' }).tone, 'detailed', 'the default tone is thorough')
assert.equal(parseRewrite({ text: 'x'.repeat(9000) }).text.length, 4000)
assert.equal(parseRewrite({ text: 'x', model: { provider: 'p', model: 'm' } }).model.model, 'm')

// A failing model still answers 200 with no rewrite, so the draft is untouched.
ctx.llm.prepareCall = async () => {
  throw new Error('no route')
}
const rewriteFailed = await postRewrite({ text: '修 bug' })
assert.equal(rewriteFailed.status, 200)
assert.deepEqual(await rewriteFailed.json(), { text: '' })

// --- the saved model choice -------------------------------------------
// The settings route reads and writes the profile patch through configEditor,
// which needs no schema: the same path the shipped model page uses.
const saved = []
let storedConfig = {}
const entry = { id: 'step-explain' }
const editor = {
  // Identity matters: the real service hands back the same Loader entry.
  configuration: () => [{ entry, inherited: {}, override: storedConfig }],
  edit: async (target, change) => {
    const next = change(storedConfig, {})
    saved.push(next)
    storedConfig = next
  },
}
const before = {
  ...ctx,
  fiber: { entry },
  get: (key) => (key === 'configEditor' ? editor : key === 'agentDefaultModel' ? ctx.agentDefaultModel : undefined),
}
const modelCtx = Object.create(before)
const modelRoutes = []
modelCtx.inject = (deps, fn) => fn(modelCtx)
modelCtx.connection = { fetch: { register: (each) => (modelRoutes.push(each), () => {}) } }
apply(modelCtx)
const model = modelRoutes.find((each) => each.path === '/api/step-explain.model')
const readModel = () => model.fetch(new Request('http://host/api/step-explain.model', { method: 'GET' }))
const writeModel = (body, headers = { 'content-type': 'application/json' }) =>
  model.fetch(
    new Request('http://host/api/step-explain.model', {
      method: 'PUT',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

assert.deepEqual(await (await readModel()).json(), { model: null }, 'nothing saved yet')

const put = await writeModel({ provider: 'local', model: 'tiny' })
assert.equal(put.status, 200)
assert.deepEqual(await put.json(), { model: { provider: 'local', model: 'tiny' } }, 'the saved choice comes back')
assert.deepEqual(saved.at(-1), { provider: 'local', model: 'tiny' }, 'the profile patch got exactly the pair')
assert.deepEqual(await (await readModel()).json(), { model: { provider: 'local', model: 'tiny' } }, 'and it reads back')

// The saved choice is what the model calls actually use.
const modelCalls = []
ctx.llm.prepareCall = async (config) => (modelCalls.push(config), { config, async *stream() { yield { type: 'text-delta', text: 'x' } } })
await modelRoutes
  .find((each) => each.path === '/api/step-explain.detail')
  .fetch(
    new Request('http://host/api/step-explain.detail', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'read', argsRaw: '{}' }),
    }),
  )
assert.deepEqual(
  { provider: modelCalls.at(-1).provider, model: modelCalls.at(-1).model },
  { provider: 'local', model: 'tiny' },
  'the saved model is used',
)

// Clearing goes back to the inherited default.
const cleared = await writeModel({})
assert.equal(cleared.status, 200)
assert.deepEqual(await cleared.json(), { model: null }, 'clearing removes the choice')
assert.deepEqual(saved.at(-1), {}, 'the clear writes an empty override, so the inherited value applies')

// Reading the profile is cached, because explain and rewrite both call it and
// `configuration()` re-parses the whole profile directory. A save must invalidate.
{
  let reads = 0
  // A fresh entry object: the cache is keyed by entry identity, so reusing the
  // earlier one would legitimately hit a cache filled by the blocks above.
  const cacheEntry = { id: 'step-explain' }
  const counting = {
    configuration: () => (reads++, [{ entry: cacheEntry, inherited: {}, override: storedConfig }]),
    edit: editor.edit,
  }
  const cacheBase = {
    ...before,
    fiber: { entry: cacheEntry },
    get: (key) => (key === 'configEditor' ? counting : key === 'agentDefaultModel' ? ctx.agentDefaultModel : undefined),
  }
  const cacheRoutes = []
  // Mirror the real `apply`: every route gets its OWN derived context, so a
  // context-keyed cache would miss on all but one of them. Passing the same
  // object to all three would hide that bug, which is what this block used to do.
  cacheBase.inject = (deps, fn) => {
    const derived = Object.create(cacheBase)
    derived.inject = cacheBase.inject
    derived.connection = { fetch: { register: (each) => (cacheRoutes.push(each), () => {}) } }
    fn(derived)
  }
  apply(cacheBase)
  const routeAt = (path) => cacheRoutes.find((each) => each.path === path)
  const readCached = () => routeAt('/api/step-explain.model').fetch(new Request('http://host/api/step-explain.model', { method: 'GET' }))
  const explain = () =>
    routeAt('/api/step-explain.detail').fetch(
      new Request('http://host/api/step-explain.detail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'read', argsRaw: '{}', lang: 'zh' }),
      }),
    )
  const rewrite = () =>
    routeAt('/api/step-explain.rewrite').fetch(
      new Request('http://host/api/step-explain.rewrite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '修 bug', tone: 'detailed', lang: 'zh' }),
      }),
    )

  await readCached()
  assert.equal(reads, 1, 'the first read parses the profile')
  await readCached()
  await explain()
  await rewrite()
  assert.equal(reads, 1, 'explain, rewrite and settings all share the one read, not one each')
  await readCached()
  assert.equal(reads, 1, 'later reads come from the cache, not the disk')
  await routeAt('/api/step-explain.model').fetch(
    new Request('http://host/api/step-explain.model', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'local', model: 'tiny' }),
    }),
  )
  assert.deepEqual(await (await readCached()).json(), { model: { provider: 'local', model: 'tiny' } }, 'a save is visible right away')
  assert.ok(reads > 1, 'and the save invalidated the cache instead of serving the old value')
}

// Bad saves are refused and write nothing.
const beforeBad = saved.length
assert.equal((await writeModel({ provider: 'only' }, { 'content-type': 'application/json' })).status, 400)
assert.equal((await writeModel({ provider: '', model: 'm' })).status, 400)
assert.equal((await writeModel({ provider: 'p', model: 7 })).status, 400)
assert.equal((await writeModel([1, 2])).status, 400)
assert.equal((await writeModel({ provider: 'p', model: 'm' }, { 'content-type': 'text/plain' })).status, 415)
assert.equal(saved.length, beforeBad, 'a refused save never reaches the profile')

// A profile that cannot write reports it instead of pretending.
const locked = []
const lockedCtx = Object.create(before)
lockedCtx.fiber = { entry: { id: 'step-explain' } }
lockedCtx.inject = (deps, fn) => fn(lockedCtx)
lockedCtx.connection = { fetch: { register: (each) => (locked.push(each), () => {}) } }
lockedCtx.get = (key) => (key === 'configEditor' ? { configuration: () => [], edit: async () => { throw new Error('read-only') } } : key === 'agentDefaultModel' ? ctx.agentDefaultModel : undefined)
apply(lockedCtx)
const lockedPut = await locked
  .find((each) => each.path === '/api/step-explain.model')
  .fetch(
    new Request('http://host/api/step-explain.model', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'p', model: 'm' }),
    }),
  )
assert.equal(lockedPut.status, 409, 'an unwritable profile is a conflict, not a silent success')
assert.equal((await lockedPut.json()).error, 'unavailable')

console.log('dsh-step-explain host: all self-checks passed')
