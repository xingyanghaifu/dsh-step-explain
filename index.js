/**
 * Host half of dsh-step-explain.
 *
 * One job: the "detailed explanation" switch in the chat becomes one small
 * model call. The route takes a tool name and its argument text, asks a model
 * for one or two plain sentences, and returns them. The model comes from the
 * reader's own choice in Settings, then the profile's `config`, then the chat
 * default.
 *
 * Every failure — no model, timeout, aborted stream, provider error — answers
 * with an empty detail, so the Client half keeps showing its rule-based text
 * and the approval dialog never breaks.
 *
 * Nothing here can change what the model is allowed to do: no tool guard, no
 * approval listener, no file access. Registration is optional, so a profile
 * without `connection` or `llm` still gets the rule-based explanations.
 */
export const name = 'step-explain'

/** Exact route the Client half posts to. */
const PATH = '/api/step-explain.detail'
/** Second route: rewrite one rough instruction into a clearer prompt. */
const REWRITE_PATH = '/api/step-explain.rewrite'
/** Settings route: read and save the model this plugin uses. */
const MODEL_PATH = '/api/step-explain.model'
/** Transcript route: the whole conversation, for the chat-picking drawer. */
const CHAT_PATH = '/api/step-explain.chat'
const MAX_ARGS_CHARS = 2000
const MAX_DETAIL_CHARS = 600
/** A rewrite may be longer than a one-line explanation but still bounded. */
const MAX_REWRITE_CHARS = 4000
/**
 * How much conversation a rewrite may carry.
 *
 * Not a product limit: the reader decides how much to tick, and a rewrite is
 * its own isolated request, so the real ceiling is the model's context window.
 * This constant only stops a pathological body (a multi-megabyte paste) from
 * reaching the provider, where it would fail more slowly and less clearly.
 */
const MAX_CONTEXT_CHARS = 1_000_000
const MAX_ID_CHARS = 120
const TIMEOUT_MS = 20_000
/** A rewrite carries the conversation, so it gets more room than one step. */
const REWRITE_TIMEOUT_MS = 60_000
/** And more still once the context is large enough to slow the model down. */
const REWRITE_TIMEOUT_LONG_MS = 120_000
/** Context above this many characters counts as "large". */
const REWRITE_LONG_CONTEXT_CHARS = 200_000
/** Prose only: no Markdown, no restating the arguments, no advice. */
const SYSTEM = {
  zh: '你在给新手解释电脑操作。用一到两句话说明这一步在做什么、会改动什么。不要用 Markdown，不要复述参数原文，不要评价好坏，不要给建议。',
  en: 'You explain computer actions to beginners. In one or two sentences say what this step does and what it changes. No Markdown, do not restate the arguments, do not judge, do not advise.',
}

/**
 * Extra instruction per study level, so a model-written explanation carries the
 * same parts the rule text does. `now` keeps the plain one-liner above; an
 * unknown level falls back to it rather than asking for something undefined.
 */
const STUDY = {
  now: { zh: '', en: '' },
  why: {
    zh: '再补一句这类操作通常是为了什么，措辞用「通常」，不要猜测这个模型的具体意图。',
    en: 'Add one sentence on what this kind of operation is usually for, phrased with "usually"; never guess this particular model\'s motive.',
  },
  plan: {
    zh: '再补一句这类操作通常是为了什么，最后再说一句下一步通常会发生什么。都用「通常」「多半」这类措辞，不要猜测这个模型的具体意图。',
    en: 'Add one sentence on what this kind of operation is usually for, then one on what commonly comes next. Use "usually" and "most likely"; never guess this particular model\'s motive.',
  },
}
/**
 * Rewriting is a different job: keep the author's intent, add only what the
 * request leaves implicit, and never invent facts, files or requirements.
 */
const REWRITE_SYSTEM = {
  zh: '你把用户写给 AI 助手的粗糙指令改写成更清楚、更具体的指令。保留原意，补上能让助手直接动手的细节（目标、范围、期望结果、验收方式），但不要编造用户没提到的文件、路径、技术栈或需求。直接输出改写后的指令正文，不要解释你改了什么，不要用 Markdown 代码块，不要加引号，不要加“改写后：”之类的前缀。如果用户在同一段里提出了修改要求，就按要求重写整段。',
  en: 'You rewrite a rough instruction for an AI assistant into a clearer, more specific one. Keep the intent and add only the detail that lets the assistant act (goal, scope, expected result, how to verify), never inventing files, paths, stacks or requirements the user did not mention. Output only the rewritten instruction: no explanation of your changes, no Markdown fence, no quotes, no "Rewritten:" prefix. If the user also asked for a change, apply it and rewrite the whole instruction.',
}
/**
 * How the reader wants the rewrite shaped, from shortest to fullest. Each level
 * says what to add or leave out, so the three produce visibly different lengths.
 */
const TONE = {
  concise: {
    zh: '尽量短：能省的字都省掉，不重复原话，整段控制在两三句以内。',
    en: 'Keep it short: cut every word you can, do not repeat the original, and stay within two or three sentences.',
  },
  balanced: {
    zh: '长度适中：一句话说清目标，再补必要的范围和期望结果，不逐条罗列。',
    en: 'Medium length: state the goal in one sentence, then add only the scope and expected result that matter, without turning it into a list.',
  },
  detailed: {
    zh: '写得详细些：分点列出目标、范围、步骤、验收方式，每点一句话。',
    en: 'Be thorough: list the goal, scope, steps and how to verify as separate points, one sentence each.',
  },
}

/** Flatten model output to one bounded paragraph; both ends are untrusted. */
export function clean(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS - 1)}…` : flat
}

/**
 * Tidy a rewrite: keep its line structure (a list stays a list), strip the
 * fences and prefixes a model likes to add, and bound the length.
 */
export function cleanRewrite(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
  const body = lines
    .filter((line, index) => !(line === '' && (index === 0 || lines[index - 1] === '')))
    .join('\n')
    .replace(/^```[^\n]*\n?|\n?```$/g, '')
    .replace(/^(?:改写后|改写的指令|重写后|Rewritten|Rewrite)\s*[:：]\s*/i, '')
    .trim()
  return body.length > MAX_REWRITE_CHARS ? `${body.slice(0, MAX_REWRITE_CHARS - 1)}…` : body
}

/** One provider/model pair, or undefined when either half is missing. */
function routeOf(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const { provider, model } = value
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  return { provider: provider.slice(0, MAX_ID_CHARS), model: model.slice(0, MAX_ID_CHARS) }
}

/**
 * Validate one request at the wire: a JSON object with a tool name.
 * @param body - decoded request body.
 * @returns tool name, bounded argument text, answer language and the reader's
 *   model choice, or undefined.
 */
export function parseInput(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const { name, argsRaw, lang, model, study } = body
  if (typeof name !== 'string' || name.trim() === '') return undefined
  if (argsRaw !== undefined && typeof argsRaw !== 'string') return undefined
  if (model !== undefined && routeOf(model) === undefined) return undefined
  if (study !== undefined && (typeof study !== 'string' || STUDY[study] === undefined)) return undefined
  return {
    name: name.slice(0, MAX_ID_CHARS),
    argsRaw: (argsRaw ?? '').slice(0, MAX_ARGS_CHARS),
    lang: typeof lang === 'string' && lang.startsWith('zh') ? 'zh' : 'en',
    // The study level shapes the prompt; an absent one keeps the short answer.
    study: study ?? 'now',
    ...(model === undefined ? {} : { model: routeOf(model) }),
  }
}

/**
 * Validate one rewrite request: the draft plus, optionally, how to shape it,
 * the language, the reader's model choice and the conversation context the
 * reader agreed to send.
 * @param body - decoded request body.
 * @returns text, tone, language, model, previous draft and context, or undefined.
 */
export function parseRewrite(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const { text, tone, lang, model, previous, instruction, context } = body
  if (typeof text !== 'string' || text.trim() === '') return undefined
  if (tone !== undefined && (typeof tone !== 'string' || TONE[tone] === undefined)) return undefined
  if (previous !== undefined && typeof previous !== 'string') return undefined
  if (instruction !== undefined && typeof instruction !== 'string') return undefined
  if (model !== undefined && routeOf(model) === undefined) return undefined
  // The context is a plain transcript the browser assembled; anything else is
  // refused rather than coerced, so a caller cannot smuggle a structure in.
  if (context !== undefined && typeof context !== 'string') return undefined
  return {
    text: text.slice(0, MAX_REWRITE_CHARS),
    tone: tone ?? 'detailed',
    lang: typeof lang === 'string' && lang.startsWith('zh') ? 'zh' : 'en',
    previous: (previous ?? '').slice(0, MAX_REWRITE_CHARS),
    instruction: (instruction ?? '').slice(0, MAX_ARGS_CHARS),
    context: (context ?? '').slice(0, MAX_CONTEXT_CHARS),
    ...(model === undefined ? {} : { model: routeOf(model) }),
  }
}

/** The same model precedence as the detail route, shared by both callers. */
function selectModel(ctx, input, route) {
  return input.model ?? route ?? ctx.get('agentDefaultModel')?.currentSelection()
}

/**
 * Last route read from the profile, with the Loader entry it was read for.
 *
 * `configEditor.configuration()` re-parses the whole profile directory, and
 * `savedRoute` runs on every explain and rewrite request. The saved value only
 * changes through `saveRoute` here, so one read per entry is enough.
 *
 * Keyed by `ctx.fiber.entry`, never by the context object: `apply` registers
 * each route inside its own `ctx.inject(...)`, so every route calls
 * `savedRoute` with a different context and a context-keyed cache would miss
 * on all but one of them. The entry is the same Loader row for all of them.
 * shortcut: a profile patch edited by hand mid-session is not noticed until the
 * plugin reloads; upgrade to a file watch if that becomes a real workflow.
 */
let routeCache

/**
 * Join the text blocks of one message, ignoring reasoning and tool payloads.
 * @param blocks - block array, or a plain string for older shapes.
 * @returns the readable text, or '' when there is none.
 */
function blocksText(blocks) {
  if (typeof blocks === 'string') return blocks.replace(/\s+/g, ' ').trim()
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.kind !== 'text' && block.type !== 'text') continue
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * The readable messages of one session's event log, oldest first.
 *
 * Takes the raw log rather than the model-visible surface: compaction marks old
 * messages as shadowed, and the reader still needs to pick them. Assistant text
 * lives at `data.message.content`; a user message keeps it at `data.content`.
 * @param events - session events, in log order.
 * @returns `[{ who: 'user' | 'assistant', text }]`.
 */
export function transcriptOf(events) {
  if (!Array.isArray(events)) return []
  const out = []
  for (const event of events) {
    if (event === null || event === undefined || typeof event !== 'object') continue
    // 'append' is a real message; shadow/remove events are compaction bookkeeping.
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
    const who = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : ''
    if (who === '') continue
    if (who === 'user') {
      const source = event.data?.source
      if (source !== undefined && source.kind !== 'user') continue
    }
    const text = blocksText(who === 'assistant' ? event.data?.message?.content : event.data?.content)
    if (text === '') continue
    out.push({ who, text })
  }
  return out
}

/**
 * The full event log for one session.
 *
 * `sessionQuery.readSession` answers for both a live and a cold session, which is
 * what the drawer needs. The live Session's own surface is only the model-visible
 * window, so it is the fallback, not the source.
 * @param ctx - Host context.
 * @param sessionId - the session to read.
 * @returns session events, or an empty array.
 */
async function readSessionEvents(ctx, sessionId) {
  try {
    const answer = await ctx.get('sessionQuery')?.readSession?.(sessionId)
    if (Array.isArray(answer?.events)) return answer.events
  } catch {
    // fall through to the live session
  }
  try {
    const session = ctx.get('sessions')?.get?.(sessionId)
    if (session === undefined) return []
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
    const seqs = session.surface?.nodes
    if (!Array.isArray(seqs)) return []
    return seqs.map((seq) => {
      try {
        return session.eventAt(seq)
      } catch {
        return undefined
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/** The context window of the model this plugin would use, when the Host knows it. */
async function readContextWindow(ctx, session) {
  const llm = ctx.llm ?? ctx.get('llm')
  // The plugin's own saved choice wins: that is the model the rewrite will use.
  const saved = savedRoute(ctx)
  if (saved !== undefined) {
    try {
      const info = await llm?.resolveModelInfo?.(saved.provider, saved.model)
      const size = info?.context?.contextWindow
      if (typeof size === 'number' && size > 0) return size
    } catch {
      // fall through
    }
  }
  // No saved choice: the session's own request context is the real route.
  try {
    const size = session?.requestContext?.()?.contextWindow
    if (typeof size === 'number' && size > 0) return size
  } catch {
    // fall through
  }
  try {
    const fallback = ctx.get('agentDefaultModel')?.currentSelection()
    if (fallback !== undefined) {
      const info = await llm?.resolveModelInfo?.(fallback.provider, fallback.model)
      const size = info?.context?.contextWindow
      if (typeof size === 'number' && size > 0) return size
    }
  } catch {
    // unknown
  }
  return undefined
}

/**
 * POST /api/step-explain.chat — the whole transcript for one session.
 *
 * Answers `{ messages: [], contextWindow: null }` for anything it cannot read,
 * so the drawer falls back to the loaded window instead of breaking.
 */
async function handleChat(ctx, request) {
  if (!String(request.headers.get('content-type')).startsWith('application/json')) {
    return Response.json({ error: 'json' }, { status: 415 })
  }
  const body = await request.json().catch(() => undefined)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.slice(0, MAX_ID_CHARS) : ''
  if (sessionId === '') return Response.json({ error: 'invalid' }, { status: 400 })
  try {
    const session = ctx.get('sessions')?.get?.(sessionId)
    const events = await readSessionEvents(ctx, sessionId)
    const contextWindow = await readContextWindow(ctx, session)
    return Response.json(
      {
        messages: transcriptOf(events),
        contextWindow: contextWindow ?? null,
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch {
    return Response.json({ messages: [], contextWindow: null })
  }
}

/**
 * Read the saved model from the profile patch, or undefined when unset.
 *
 * The profile's own layer wins; a bundle-provided default is the fallback. When
 * neither has a pair this plugin follows the chat model.
 * @param ctx - Host context; `configEditor` is optional.
 * @returns the saved provider/model pair.
 */
function savedRoute(ctx) {
  const entry = ctx.fiber?.entry
  if (routeCache !== undefined && routeCache.entry === entry) return routeCache.route
  let route
  try {
    const editor = ctx.get('configEditor')
    if (editor === undefined || entry === undefined) return undefined
    const row = editor.configuration().find((each) => each.entry === entry)
    if (row !== undefined) {
      // `override` is this profile's patch layer; `inherited` is the bundle default.
      route = routeOf(row.override) ?? routeOf(row.inherited)
    }
  } catch {
    return undefined
  }
  routeCache = { entry, route }
  return route
}

/**
 * Persist one model choice into the profile patch, exactly the way the shipped
 * model settings page writes its own selection.
 * @param ctx - Host context; needs `configEditor`.
 * @param next - validated provider/model pair, or undefined to clear it.
 */
async function saveRoute(ctx, next) {
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  if (editor === undefined || entry === undefined) throw new Error('configuration is not editable here')
  // An empty object clears the override and the inherited default applies again.
  await editor.edit(entry, () => (next === undefined ? {} : { provider: next.provider, model: next.model }))
  // Deliberately after the await: if the write throws, the profile still holds
  // the old value, so the cached read is still correct and stays. The only
  // writer is this function, so once it succeeds the cache is stale.
  routeCache = undefined
}

/**
 * Ask a model what one Tool call does.
 * @param ctx - Host context carrying `llm`.
 * @param input - validated tool name, argument text, language and model choice.
 * @param route - the profile's configured model, or undefined.
 * @param signal - aborted on timeout or when the browser goes away.
 * @returns the assembled answer text, possibly empty.
 */
async function ask(ctx, input, route, signal) {
  // The saved Settings choice wins, then the profile pin, then the chat default.
  // `agentDefaultModel` is optional, so read it late instead of injecting it.
  const selected = selectModel(ctx, input, savedRoute(ctx) ?? route)
  if (!selected) return ''
  const call = await ctx.llm.prepareCall(
    // Room for the study lines too; `now` still answers in a sentence or two.
    { provider: selected.provider, model: selected.model, maxTokens: input.study === 'now' ? 200 : 320 },
    signal,
  )
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: `Tool: ${input.name}\nArguments: ${input.argsRaw === '' ? '(none)' : input.argsRaw}` }],
    },
  ]
  // The level's extra sentence is appended to the same system prompt, so one
  // request still produces the whole explanation at that level.
  const extra = STUDY[input.study]?.[input.lang] ?? ''
  const system = extra === '' ? SYSTEM[input.lang] : `${SYSTEM[input.lang]}\n${extra}`
  let text = ''
  for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

/**
 * Ask a model to rewrite one rough instruction.
 * @param ctx - Host context carrying `llm`.
 * @param input - validated rewrite request.
 * @param route - the profile's configured model, or undefined.
 * @param signal - aborted on timeout or when the browser goes away.
 * @returns the rewritten instruction, possibly empty.
 */
async function rewrite(ctx, input, route, signal) {
  const selected = selectModel(ctx, input, savedRoute(ctx) ?? route)
  // `currentSelection()` answers null when the profile has no model, so this is
  // falsy rather than strictly undefined.
  if (!selected) throw Object.assign(new Error('no-model'), { reason: 'no-model' })
  const call = await ctx.llm.prepareCall(
    { provider: selected.provider, model: selected.model, maxTokens: 1200 },
    signal,
  )
  const system = `${REWRITE_SYSTEM[input.lang]}\n${TONE[input.tone][input.lang]}`
  // The conversation, when the reader turned context on. It is labelled and
  // fenced off so the model treats it as background for what the draft means,
  // never as a second instruction to obey — the draft is still the thing being
  // rewritten.
  const parts = []
  if (input.context !== '') {
    parts.push(
      `[${input.lang === 'zh' ? '当前对话的最近内容（只用来理解下面这句话指的是什么，不要改写它，也不要照抄）' : 'Recent content of this conversation (only to understand what the sentence below refers to; do not rewrite it and do not copy it)'}]\n${input.context}\n`,
    )
  }
  parts.push(input.text)
  // The previous rewrite is context for "make it shorter", never a second
  // instruction to obey; it is labelled so the model cannot mistake it.
  if (input.previous !== '') parts.push(`\n[${input.lang === 'zh' ? '上一版' : 'Previous version'}]\n${input.previous}`)
  if (input.instruction !== '') {
    parts.push(`\n[${input.lang === 'zh' ? '这次的修改要求' : 'This change'}] ${input.instruction}`)
  }
  const messages = [{ role: 'user', content: [{ type: 'text', text: parts.join('\n') }] }]
  let text = ''
  for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

/** Detail route: validate, then one bounded model call. Never throws. */
async function handle(ctx, request, route) {
  if (!String(request.headers.get('content-type')).startsWith('application/json')) {
    return Response.json({ detail: '' }, { status: 415 })
  }
  const input = parseInput(await request.json().catch(() => undefined))
  if (input === undefined) return Response.json({ detail: '' }, { status: 400 })
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)])
  let detail = ''
  try {
    detail = clean(await ask(ctx, input, route, signal))
  } catch {
    // No provider, a refused request or a slow model: the rules still explain.
  }
  return Response.json({ detail }, { headers: { 'cache-control': 'no-store' } })
}

/** Rewrite route: same fence, same degradation — an empty rewrite changes nothing. */
async function handleRewrite(ctx, request, route) {
  if (!String(request.headers.get('content-type')).startsWith('application/json')) {
    return Response.json({ text: '' }, { status: 415 })
  }
  const input = parseRewrite(await request.json().catch(() => undefined))
  if (input === undefined) return Response.json({ text: '', reason: 'bad-request' }, { status: 400 })
  // A long conversation is slower to send and slower to answer, so the budget
  // scales with what the reader asked to attach.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(rewriteBudget(input.context))])
  let text = ''
  let reason = null
  try {
    text = cleanRewrite(await rewrite(ctx, input, route, signal))
    // A model that answered nothing is a failure the reader can retry, not a
    // rewrite that happens to be empty.
    if (text === '') reason = 'empty'
  } catch (error) {
    // A failed rewrite leaves the draft exactly as the reader typed it; the
    // reason lets the Client say which failure it was.
    reason = reasonOf(error, signal)
  }
  return Response.json({ text, reason }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * How long a rewrite may take, given how much conversation it carries.
 * @param context - the transcript the reader attached, possibly empty.
 * @returns milliseconds.
 */
export function rewriteBudget(context) {
  return String(context ?? '').length > REWRITE_LONG_CONTEXT_CHARS ? REWRITE_TIMEOUT_LONG_MS : REWRITE_TIMEOUT_MS
}

/**
 * Why a rewrite produced nothing, as one of the reasons the Client can phrase.
 * @param error - whatever `rewrite` threw.
 * @param signal - the request's abort signal.
 * @returns 'no-model' | 'timeout' | 'provider'.
 */
export function reasonOf(error, signal) {
  if (typeof error?.reason === 'string') return error.reason
  if (signal?.aborted) return 'timeout'
  const message = String(error?.message ?? error).toLowerCase()
  if (message.includes('abort') || message.includes('timeout') || message.includes('timed out')) return 'timeout'
  return 'provider'
}

/**
 * Validate one save request: `{provider, model}` to pin, or `{}` to clear.
 * @param body - decoded request body.
 * @returns the pair, `null` for "clear", or undefined when malformed.
 */
export function parseModelChoice(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const { provider, model } = body
  if (provider === undefined && model === undefined) return null
  const route = routeOf({ provider, model })
  return route ?? undefined
}

/** GET returns the saved choice; PUT saves or clears it. Never throws. */
async function handleModel(ctx, request) {
  if (request.method === 'GET') {
    return Response.json({ model: savedRoute(ctx) ?? null }, { headers: { 'cache-control': 'no-store' } })
  }
  if (!String(request.headers.get('content-type')).startsWith('application/json')) {
    return Response.json({ error: 'json' }, { status: 415 })
  }
  const choice = parseModelChoice(await request.json().catch(() => undefined))
  if (choice === undefined) {
    // The Client turns this into an inline message; nothing is written.
    return Response.json({ error: 'invalid' }, { status: 400 })
  }
  try {
    await saveRoute(ctx, choice ?? undefined)
  } catch (error) {
    return Response.json({ error: 'unavailable', message: String(error?.message ?? error) }, { status: 409 })
  }
  return Response.json({ model: savedRoute(ctx) ?? null }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * Register all three routes inside Connection's authentication fence.
 * @param ctx - Host context with `connection` and `llm`.
 * @param config - optional `provider`/`model` pair pinning the model.
 */
export function apply(ctx, config) {
  const route = routeOf(config)
  for (const [path, fetch, methods] of [
    [PATH, handle, ['POST']],
    [REWRITE_PATH, handleRewrite, ['POST']],
    [MODEL_PATH, handleModel, ['GET', 'PUT']],
    [CHAT_PATH, handleChat, ['POST']],
  ]) {
    ctx.inject(['connection', 'llm'], (sctx) =>
      sctx.connection.fetch.register({
        path,
        methods,
        requestBody: 'buffered',
        fetch: (request) => fetch(sctx, request, route),
      }),
    )
  }
}
