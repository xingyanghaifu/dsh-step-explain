window.__ModuleLoader__.load({
  id: 'dsh-step-explain',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /** Dictionary namespace owned by this plugin. */
    const NS = 'step-explain'
    const STYLE_ID = 'dsh-step-explain/style'
    /** Dot colour per risk level, from the shipped theme aliases. */
    const RISK_COLOUR = {
      low: 'var(--dsw-alias-state-success-primary)',
      medium: 'var(--dsw-alias-state-warn-primary)',
      high: 'var(--dsw-alias-state-error-primary)',
    }

    // --- what each tool does, in plain language -------------------------
    /** Tool name -> plain category. Unlisted tools fall back to `control`. */
    const CATEGORY = {
      read: 'read',
      read_image: 'read',
      skill: 'read',
      glob: 'search',
      grep: 'search',
      write: 'write',
      edit: 'write',
      str_replace_editor: 'write',
      pwsh: 'exec',
      bash: 'exec',
      terminal_open: 'exec',
      terminal_send: 'exec',
      web_search: 'net',
      web_fetch: 'net',
      ask_user_question: 'ask',
    }
    /** The object a call acts on, picked out of its parsed arguments. */
    const TARGET = {
      read: (a) => a.file_path ?? a.path,
      read_image: (a) => a.file_path ?? a.path,
      write: (a) => a.file_path ?? a.path,
      edit: (a) => a.file_path ?? a.path,
      str_replace_editor: (a) => a.path ?? a.file_path,
      glob: (a) => a.pattern,
      grep: (a) => a.pattern,
      pwsh: (a) => a.command,
      bash: (a) => a.command,
      terminal_open: (a) => a.cwd,
      terminal_send: (a) => a.text,
      web_search: (a) => (Array.isArray(a.queries) ? a.queries.join(' / ') : a.query),
      web_fetch: (a) => a.url,
      present: (a) => (Array.isArray(a.files) ? a.files.map((file) => file?.path).filter(Boolean).join(', ') : ''),
      ask_user_question: (a) => a.questions?.[0]?.header ?? a.questions?.[0]?.question,
      skill: (a) => a.name,
      todo_write: (a) => (Array.isArray(a.todos) ? String(a.todos.length) : ''),
      working_directory: (a) => a.cd,
      send_message: (a) => a.target,
    }
    /** Command shapes that destroy data outright, called out before approval. */
    const DANGER = /(?:^|[;&|]\s*)rm\s+-[a-z]*[rf]|Remove-Item[^|;]*-Recurse|\bdel\s+\/[sq]|git\s+push\b[^|;]*(?:--force|\s-f\b)|git\s+reset\s+--hard|\bDROP\s+(?:TABLE|DATABASE)|\bTRUNCATE\s+TABLE|\|\s*(?:ba|z)?sh\b|Invoke-Expression/i

    /**
     * Describe one Tool call without inventing the model's motive.
     * @param name - tool name as the Host reported it.
     * @param argsRaw - the JSON argument text, possibly partial or malformed.
     * @param t - translate for this plugin's namespace.
     * @returns category, risk, label, target and the three explanation lines.
     */
    function explain(name, argsRaw, t) {
      let args = {}
      try {
        const parsed = JSON.parse(argsRaw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed
      } catch {
        // Partial or malformed arguments: explain the tool, not the arguments.
      }
      const tool = String(name ?? '')
      const cat = CATEGORY[tool] ?? (/^(?:cordis_inspect|session_)/.test(tool) ? 'read' : 'control')
      let target = ''
      try {
        const value = TARGET[tool]?.(args)
        if (typeof value === 'string') target = value.slice(0, 160)
        else if (typeof value === 'number') target = String(value)
      } catch {
        // An unexpected argument shape must never break the chat.
      }
      const danger = cat === 'exec' && DANGER.test(String(args.command ?? ''))
      const risk = danger ? 'high' : cat === 'read' || cat === 'search' || cat === 'ask' ? 'low' : 'medium'
      const key = `tool.${tool}`
      const own = t(key)
      const label = own === key ? t(`cat.${cat}.label`) : own
      // The three lines the reader asked for: what is happening now, what it is
      // usually for, and what commonly comes next. All of them are rule text per
      // category, never a guess at this model's motive: "usually" is the claim.
      // `now` reuses the category's own description: the row already shows the
      // label and the target, so repeating them here would say nothing new.
      const why = danger ? 'why.danger' : `why.${cat}`
      const next = danger ? 'next.danger' : `next.${cat}`
      return {
        cat,
        risk,
        danger,
        tool,
        // Kept so a surface can ask the model about the same call it explained.
        argsRaw,
        label,
        target,
        now: t(`cat.${cat}.what`),
        why: t(why),
        next: t(next),
        effect: t(`cat.${cat}.effect`),
        undo: t(`cat.${cat}.undo`),
      }
    }

    /** Group explained steps into `读取文件 3 · 改动文件 1`, in first-seen order. */
    function groupSteps(steps, t) {
      const counts = new Map()
      for (const step of steps) counts.set(step.label, (counts.get(step.label) ?? 0) + 1)
      return [...counts].map(([label, count]) => t('turn.part', { label, count })).join(' · ')
    }

    /** Name and raw arguments of a Tool root, running (start) or settled (result). */
    function callOf(root) {
      if (root === undefined) return { name: '', argsRaw: '' }
      return root.kind === 'tool-result'
        ? { name: root.call?.name ?? root.name ?? '', argsRaw: root.call?.argsRaw ?? '' }
        : { name: root.name ?? '', argsRaw: root.argsRaw ?? '' }
    }

    /** Explained Tool calls of one Turn, in render order. */
    function stepsOf(nodes, turnNo, t) {
      const steps = []
      for (const node of nodes) {
        if (node.kind !== 'tool-call' || node.visibility === 'hidden') continue
        if (node.location?.turn?.turn !== turnNo) continue
        const { name, argsRaw } = callOf(node.data.root)
        steps.push(explain(name, argsRaw, t))
      }
      return steps
    }

    /**
     * The recent conversation, as plain text for a rewrite to read.
     *
     * Only what the reader already sees in the chat is collected: their own
     * messages and the model's visible replies. Tool arguments, tool results,
     * reasoning and anything hidden are left out — a rewrite needs to know what
     * "那个 bug" refers to, not what the tools were doing. The tail is kept
     * because the newest exchanges are the ones that carry the referent.
     * @param nodes - chat nodes in render order, oldest first.
     * @param maxChars - hard cap on the returned text.
     * @returns one labelled transcript block per message, oldest first.
     */
    function transcriptOf(nodes, maxChars) {
      return excerptOf(nodes, maxChars).text
    }

    /**
     * The text of one chat node, and who said it -- or null for anything that is
     * not a message the reader would recognise.
     *
     * The host keeps the two sides in different places: a user node holds its
     * blocks in `data.content`, an assistant step holds them in `data.blocks`.
     * Only `text` blocks count. Reasoning, tool calls and tool results are not
     * conversation, and the plugin's contract is that a rewrite sees what the
     * reader sees, not what the tools were doing.
     */
    function messageOf(node) {
      if (node === null || typeof node !== 'object') return null
      if (node.visibility === 'hidden') return null
      const data = node.data ?? {}
      if (node.kind === 'user') {
        // Injected context and project instructions carry a role that is not the
        // reader's own voice, so they never become rewrite context.
        const role = data.role ?? node.role
        if (role !== undefined && role !== 'user') return null
        const text = blocksText(data.content ?? node.content)
        return text === '' ? null : { who: 'user', text }
      }
      if (node.kind === 'assistant-step') {
        // A step still streaming would half-send a reply; wait for it to settle.
        if (data.status === 'running') return null
        const text = blocksText(data.blocks ?? data.content)
        return text === '' ? null : { who: 'assistant', text }
      }
      return null
    }

    /** Join the `text` blocks of a message; ignore reasoning and anything else. */
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
     * Every readable message, plus the preset a mode ticks by default.
     *
     * `items` is the whole conversation, not only the part a mode would send:
     * the reader can tick a message the preset skipped, or untick one it kept,
     * and the panel lists everything so a non-contiguous pick is possible.
     * `auto` is what the budget alone would choose, and is only a default --
     * the selection left on screen is what gets sent.
     * @param nodes - chat nodes in render order, oldest first.
     * @param maxChars - hard cap on the returned text.
     * @returns `{ text, items, auto, budget, dropped, chars }`.
     */
    function excerptOf(nodes, maxChars) {
      const items = []
      for (const node of nodes) {
        const message = messageOf(node)
        if (message === null) continue
        items.push({
          who: message.who,
          text: message.text,
          // Stable across re-renders: the node id when there is one, otherwise
          // the position, which is enough because the list only grows at the end.
          key: `${node.id ?? items.length}:${message.who}`,
          line: `${message.who === 'user' ? '用户' : '助手'}\n${message.text}`,
        })
      }
      // Newest last, so trimming from the front drops the oldest exchanges.
      const auto = new Set()
      let total = 0
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const line = items[index].line
        if (total + line.length > maxChars) break
        auto.add(items[index].key)
        total += line.length + 2
      }
      return {
        text: items.filter((each) => auto.has(each.key)).map((each) => each.line).join('\n\n'),
        items,
        auto,
        budget: maxChars,
        dropped: items.length - auto.size,
        chars: total,
      }
    }

    /** The shell command of a call, uncapped: the approval dialog must never clip it. */
    function commandOf(root) {
      try {
        const args = JSON.parse(callOf(root).argsRaw)
        return typeof args.command === 'string' ? args.command : ''
      } catch {
        return ''
      }
    }

    // --- optional model detail -----------------------------------------
    /** Persisted per-browser switch; off unless the reader turns it on. */
    const DETAIL_KEY = 'dsh-step-explain/detail'
    /**
     * How much of a step's *behaviour* the reader wants explained, separate from
     * the approval-dialog detail: `now` names the action, `why` adds what it is
     * usually for, `plan` adds what commonly comes next. All three are rule text
     * per category — the plugin never guesses this model's motive.
     */
    const STUDY_KEY = 'dsh-step-explain/study'
    const STUDY_LEVELS = ['now', 'why', 'plan']
    /**
     * Whether a rewrite may read the current conversation. Off by default: it
     * sends chat text off this machine, so it is opt-in like the model levels.
     */
    const CONTEXT_KEY = 'dsh-step-explain/context'
    /**
     * Whether the one-time welcome has been dismissed.
     *
     * The hint fires the first time the plugin runs in a browser profile, which
     * is the closest thing to "just installed and enabled" the client can see.
     * Per profile on purpose: a reader who moves to another browser gets the
     * introduction there too.
     */
    const WELCOME_KEY = 'dsh-step-explain/welcome'
    /** Host route that turns one call into one short paragraph. */
    const DETAIL_ROUTE = 'api/step-explain.detail'
    /** Host route that rewrites one rough instruction. */
    const REWRITE_ROUTE = 'api/step-explain.rewrite'
    /** Host route that returns one session's whole transcript and window size. */
    const CHAT_ROUTE = 'api/step-explain.chat'
    /** Host route that reads and saves the model choice in the profile. */
    const MODEL_ROUTE = 'api/step-explain.model'
    /**
     * The model this plugin uses, as saved in the profile — not in this
     * browser. `undefined` means "no saved choice", so the chat default applies.
     */
    let modelChoice
    const modelListeners = new Set()

    /** One provider/model pair, or undefined when either half is missing. */
    function routeOf(value) {
      if (typeof value !== 'object' || value === null) return undefined
      const { provider, model } = value
      if (typeof provider !== 'string' || provider === '') return undefined
      if (typeof model !== 'string' || model === '') return undefined
      return { provider, model }
    }

    /**
     * Read the saved model from the Host.
     * @returns the saved pair, `null` for "follow the chat", or `undefined` when
     *   the Host could not answer.
     */
    async function loadModel() {
      try {
        const response = await fetch(MODEL_ROUTE, { method: 'GET', headers: { accept: 'application/json' } })
        if (!response.ok) return undefined
        const body = await response.json()
        return routeOf(body?.model) ?? null
      } catch {
        return undefined
      }
    }

    /**
     * Save the model to the profile. Nothing changes locally unless the Host
     * accepted the write, so a failure cannot look like a successful save.
     * @param next - the pair, or `null` to go back to the chat default.
     * @returns the saved value, or `undefined` when the write failed.
     */
    async function saveModel(next) {
      try {
        const response = await fetch(MODEL_ROUTE, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next ?? {}),
        })
        if (!response.ok) return undefined
        const body = await response.json()
        const saved = routeOf(body?.model) ?? null
        setModel(saved ?? undefined)
        return saved
      } catch {
        return undefined
      }
    }

    /** Adopt a value the Host just confirmed; no storage, the profile owns it. */
    function setModel(next) {
      modelChoice = next
      for (const notify of modelListeners) notify(next)
    }

    /** The choice, shared by Settings and the surfaces that ask the Host. */
    function useModelChoice() {
      const [choice, setChoice] = React.useState(modelChoice)
      React.useEffect(() => {
        modelListeners.add(setChoice)
        return () => modelListeners.delete(setChoice)
      }, [])
      return choice
    }

    /**
     * The model picker's whole state: the live catalog, the saved choice and the
     * write path. The settings row and the settings page both render from this,
     * so a change to the save or failure behaviour lands in both at once.
     * @returns the select's props plus the description text and its alert role.
     */
    function useModelPicker() {
      const choice = useModelChoice()
      const [catalog, setCatalog] = React.useState(undefined)
      const [state, setState] = React.useState('loading')
      // Both round trips land after paint, so the control has a state to show.
      React.useEffect(() => {
        let live = true
        void Promise.all([loadCatalog(), loadModel()]).then(([next, saved]) => {
          if (!live) return
          setCatalog(next)
          if (saved !== undefined) setModel(saved ?? undefined)
          setState(saved === undefined ? 'unavailable' : 'ready')
        })
        return () => {
          live = false
        }
      }, [])
      const groups = catalog?.groups ?? []
      /** Write through the Host first; a failed save leaves the old value shown. */
      const choose = async (next) => {
        setState('saving')
        const saved = await saveModel(next)
        setState(saved === undefined ? 'failed' : 'ready')
      }
      return {
        /** What the reader is told under the title, and whether it is urgent. */
        description: state === 'failed' ? 'settings.saveFailed' : state === 'unavailable' ? 'settings.unavailable' : 'settings.description',
        alert: state === 'failed' || state === 'unavailable',
        /** The select itself, identical in both places. */
        select: (t) =>
          h(
            'select',
            {
              className: 'dse-select',
              'aria-label': t('settings.title'),
              value: choice === undefined ? '' : `${choice.provider}\u0000${choice.model}`,
              // A save in flight must not race a second one.
              disabled: state === 'loading' || state === 'saving',
              onChange: (event) => {
                const picked = event.target.value
                if (picked === '') return void choose(null)
                const [provider, model] = picked.split('\u0000')
                void choose({ provider, model })
              },
            },
            h('option', { value: '' }, t('settings.followChat')),
            groups.map((group) =>
              h(
                'optgroup',
                { key: group.id, label: group.name ?? group.id },
                group.models.map((model) =>
                  h('option', { key: `${group.id}/${model.id}`, value: `${group.id}\u0000${model.id}` }, model.name ?? model.id),
                ),
              ),
            ),
          ),
      }
    }

    /**
     * How much the approval dialog explains: `rule` is the plain rule text,
     * `model` adds one model-written paragraph, `full` spells out the whole
     * dialog (what it is for, when it appears, what it shows, what each button
     * does). Only the explanation changes — never the approval itself.
     */
    const LEVELS = ['rule', 'model', 'full']
    /** Old single choices, widened to the layers they used to imply. */
    const DETAIL_LEGACY = { rule: ['rule'], model: ['rule', 'model'], full: ['rule', 'model', 'full'] }
    /** Saved layers; all three may be on at once. */
    let detailLevel = readDetail()
    const detailListeners = new Set()

    /**
     * Read a stored layer list. New values are JSON arrays; old values are one
     * of the single choices and widen to what that choice used to include.
     */
    function parseLayers(raw, allowed, legacy, fallback) {
      if (typeof raw === 'string' && raw !== '') {
        if (raw.startsWith('[')) {
          try {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) return allowed.filter((each) => parsed.includes(each))
          } catch {
            // Fall through to the legacy shape.
          }
        }
        if (Array.isArray(legacy?.[raw])) return legacy[raw].slice()
      }
      return fallback.slice()
    }

    /** Read the stored layers; storage can be disabled, so failure means the default. */
    function readDetail() {
      try {
        return parseLayers(globalThis.localStorage?.getItem(DETAIL_KEY), LEVELS, DETAIL_LEGACY, ['rule'])
      } catch {
        return ['rule']
      }
    }

    /** Store the layers for every surface; a blocked write only loses the memory. */
    function setDetail(next) {
      const list = Array.isArray(next)
        ? LEVELS.filter((each) => next.includes(each))
        : DETAIL_LEGACY[next] ?? ['rule']
      detailLevel = list
      try {
        globalThis.localStorage?.setItem(DETAIL_KEY, JSON.stringify(detailLevel))
      } catch {
        // Private mode or a full quota: the level lasts for this page.
      }
      for (const notify of detailListeners) notify(detailLevel)
    }

    /** The level, shared by every rendered surface. */
    function useDetailLevel() {
      const [level, setLevel] = React.useState(detailLevel)
      React.useEffect(() => {
        detailListeners.add(setLevel)
        return () => detailListeners.delete(setLevel)
      }, [])
      return level
    }

    /**
     * Saved study level. The default is the fullest one: the whole point of the
     * plugin is to say what a step is for and what follows, and a reader who
     * wants less can turn it down. An unreadable value falls back to that.
     */
    const STUDY_DEFAULT = ['now', 'why', 'plan']
    /** Old single choices widened to the parts they used to include. */
    const STUDY_LEGACY = {
      now: ['now'],
      why: ['now', 'why'],
      plan: ['now', 'why', 'plan'],
    }
    let studyLevel = readStudy()
    const studyListeners = new Set()

    /** Read the stored study parts; a blocked read means the default. */
    function readStudy() {
      try {
        return parseLayers(globalThis.localStorage?.getItem(STUDY_KEY), STUDY_LEVELS, STUDY_LEGACY, STUDY_DEFAULT)
      } catch {
        return STUDY_DEFAULT.slice()
      }
    }

    /** Store the study parts for every surface; a blocked write only loses it. */
    function setStudy(next) {
      const list = Array.isArray(next)
        ? STUDY_LEVELS.filter((each) => next.includes(each))
        : STUDY_LEGACY[next] ?? STUDY_DEFAULT
      studyLevel = list
      try {
        globalThis.localStorage?.setItem(STUDY_KEY, JSON.stringify(studyLevel))
      } catch {
        // Private mode or a full quota: the level lasts for this page.
      }
      for (const notify of studyListeners) notify(studyLevel)
    }

    /** The study level, shared by every rendered surface. */
    function useStudyLevel() {
      const [level, setLevel] = React.useState(studyLevel)
      React.useEffect(() => {
        studyListeners.add(setLevel)
        return () => studyListeners.delete(setLevel)
      }, [])
      return level
    }

    /** Which of `now`/`why`/`plan` a value includes, in reading order. */
    function studyParts(level) {
      if (Array.isArray(level)) return STUDY_LEVELS.filter((each) => level.includes(each))
      const upto = STUDY_LEVELS.indexOf(level)
      return STUDY_LEVELS.slice(0, upto === -1 ? 1 : upto + 1)
    }

    /** Flip one layer in a canonical-ordered list. */
    function toggleLayer(list, key, order) {
      return list.includes(key) ? list.filter((each) => each !== key) : order.filter((each) => each === key || list.includes(each))
    }

    /**
     * Request body for the Host: the call, the answer language and how much to
     * explain. The model is not sent — the Host reads the saved choice from the
     * profile itself.
     */
    function detailPayload(call, lang, study) {
      // Always a list on the wire, so the Host has one shape to validate.
      return { name: call.name, argsRaw: call.argsRaw, lang, study: studyParts(study) }
    }

    /** Active language for the model prompt; `apply` binds this to the locale service. */
    let langNow = () => 'en'

    /** Live model catalog; `apply` binds this to the session Remote. */
    let catalogNow = async () => []

    /** Whatever the Host called the answer; anything else explains nothing. */
    function pickDetail(body) {
      const detail = typeof body === 'object' && body !== null ? body.detail : ''
      return typeof detail === 'string' ? detail : ''
    }

    /**
     * Cap one model answer so a chatty model cannot push the impact and undo
     * lines off screen. The Host already caps at 600 characters; this is the
     * tighter, layout-driven limit for a line that sits inside a chat row.
     */
    const MAX_MODEL_LINE = 240

    /** Clip to the last whole character boundary with an ellipsis. */
    function clipModelLine(text) {
      const flat = text.replace(/\s+/g, ' ').trim()
      return flat.length <= MAX_MODEL_LINE ? flat : `${flat.slice(0, MAX_MODEL_LINE - 1)}…`
    }

    /** The model groups the Host advertises, or none when it cannot answer. */
    async function loadCatalog() {
      try {
        return await catalogNow()
      } catch {
        return undefined
      }
    }

    // --- rewriting a rough instruction ---------------------------------
    /**
     * One session's whole transcript, as the Host sees it.
     *
     * The chat itself only keeps the loaded window in memory, so the drawer asks
     * the Host for the full history. Anything unexpected answers `undefined`,
     * which leaves the drawer on the loaded window instead of breaking.
     */
    async function fetchChat(sessionId, signal) {
      try {
        const response = await fetch(CHAT_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
          signal,
        })
        if (!response.ok) return undefined
        const body = await response.json()
        const messages = Array.isArray(body?.messages)
          ? body.messages
              .filter(
                (each) =>
                  each !== null &&
                  typeof each === 'object' &&
                  (each.who === 'user' || each.who === 'assistant') &&
                  typeof each.text === 'string' &&
                  each.text !== '',
              )
              .map((each) => ({ who: each.who, text: each.text }))
          : []
        const contextWindow =
          typeof body?.contextWindow === 'number' && body.contextWindow > 0 ? body.contextWindow : undefined
        return { messages, contextWindow }
      } catch {
        return undefined
      }
    }

    /** Whether this bar may ask the Host for a transcript at all. */
    function shouldReadTranscript(sessionId, enabled) {
      return enabled === true && typeof sessionId === 'string' && sessionId !== ''
    }

    /**
     * The Host transcript for this session, or undefined while unknown.
     *
     * `enabled` is false while the reader has picked "do not read": the whole
     * transcript must not be pulled off the Host just because the composer
     * mounted.
     */
    /** The transcript only counts for the session it was actually read from. */
    function historyFor(loaded, sessionId) {
      return loaded !== undefined && loaded.sessionId === sessionId ? loaded.history : undefined
    }

    function useChatHistory(sessionId, enabled) {
      // Stored with its session: after a switch the previous conversation must
      // not stand in for the new one while the new request is in flight.
      const [loaded, setLoaded] = React.useState(undefined)
      React.useEffect(() => {
        if (!shouldReadTranscript(sessionId, enabled)) return undefined
        const controller = new AbortController()
        let live = true
        void fetchChat(sessionId, controller.signal).then((answer) => {
          if (live && answer !== undefined) setLoaded({ sessionId, history: answer })
        })
        return () => {
          live = false
          controller.abort()
        }
      }, [sessionId, enabled])
      return historyFor(loaded, sessionId)
    }

    /**
     * One rewrite request. The previous version and the change request are
     * context for the model, never instructions to the Host: nothing here is
     * executed, and the answer only ever lands in the draft.
     */
    async function fetchRewrite({ text, tone, lang, previous, instruction, context }, signal, waitOverride) {
      // A machine that knows it has no network should say so at once, not wait
      // out a connection that will never open.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { text: '', reason: 'offline' }
      }
      // The outer signal is the caller's (unmount); the timer is ours. Either
      // one aborts the request, and `timedOut` tells the two apart.
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, waitOverride ?? rewriteWaitFor(context))
      const relay = () => controller.abort()
      if (signal !== undefined) signal.addEventListener('abort', relay)
      try {
        const response = await fetch(REWRITE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            tone,
            lang,
            ...(previous === undefined || previous === '' ? {} : { previous }),
            ...(instruction === undefined || instruction === '' ? {} : { instruction }),
            // Absent entirely when the switch is off, so the Host never has to
            // distinguish "empty context" from "context not offered".
            ...(context === undefined || context === '' ? {} : { context }),
          }),
          signal: controller.signal,
        })
        if (!response.ok) return { text: '', reason: 'provider' }
        const body = await response.json()
        const answer = typeof body?.text === 'string' ? body.text : ''
        const reason = typeof body?.reason === 'string' ? body.reason : answer === '' ? 'empty' : null
        return { text: answer, reason }
      } catch (error) {
        if (timedOut || error?.name === 'TimeoutError') return { text: '', reason: 'timeout' }
        // The caller ignores this when it aborted on purpose; otherwise the
        // request never reached the Host.
        return { text: '', reason: 'offline' }
      } finally {
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', relay)
      }
    }


    /**
     * How long the browser waits for a rewrite before it calls it dead.
     *
     * The Host has its own budget (60s, or 120s with a large transcript). These
     * sit a little above that so the Host's specific answer normally wins — but
     * when the request never leaves the machine, only these stop the button
     * from sitting on "正在改写…" forever.
     */
    const REWRITE_WAIT_MS = 70_000
    const REWRITE_WAIT_LONG_MS = 130_000
    const REWRITE_WAIT_LONG_CONTEXT_CHARS = 200_000

    /** The browser's ceiling for this request, mirroring the Host's tiers. */
    function rewriteWaitFor(context) {
      return String(context ?? '').length > REWRITE_WAIT_LONG_CONTEXT_CHARS ? REWRITE_WAIT_LONG_MS : REWRITE_WAIT_MS
    }

    /** Reason codes the Host reports, mapped to the sentence a reader sees. */
    const REWRITE_REASON_KEY = {
      'no-model': 'rewrite.reason.noModel',
      timeout: 'rewrite.reason.timeout',
      provider: 'rewrite.reason.provider',
      offline: 'rewrite.reason.offline',
      empty: 'rewrite.reason.empty',
      'bad-request': 'rewrite.reason.provider',
    }

    /** One explanation for this call, or `''` for every kind of failure. */
    async function fetchDetail(call, lang, signal, study) {
      try {
        const response = await fetch(DETAIL_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(detailPayload(call, lang, study)),
          signal,
        })
        return response.ok ? pickDetail(await response.json()) : ''
      } catch {
        return ''
      }
    }

    /**
     * Whether every step's explanation goes to the current model, not only the
     * approval dialog's. Off by default: each step is one request, so the reader
     * opts in. Stored per browser like the other levels.
     */
    const EXPLAIN_KEY = 'dsh-step-explain/explain'
    let explainByModel = readExplain()
    const explainListeners = new Set()

    /** Read the stored switch; a blocked read keeps the cheap default (off). */
    function readExplain() {
      try {
        return globalThis.localStorage?.getItem(EXPLAIN_KEY) === 'on'
      } catch {
        return false
      }
    }

    /** Store the switch for every surface; a blocked write only loses it. */
    function setExplain(next) {
      explainByModel = next === true
      try {
        globalThis.localStorage?.setItem(EXPLAIN_KEY, explainByModel ? 'on' : 'off')
      } catch {
        // Private mode or a full quota: the switch lasts for this page.
      }
      for (const notify of explainListeners) notify(explainByModel)
    }

    /** The switch, shared by every rendered surface. */
    function useExplainByModel() {
      const [on, setOn] = React.useState(explainByModel)
      React.useEffect(() => {
        explainListeners.add(setOn)
        return () => explainListeners.delete(setOn)
      }, [])
      return on
    }

    /**
     * Whether a rewrite may read the conversation.
     *
     * Two modes only. `off` sends just the composer text. `full` offers the whole
     * conversation and the reader ticks what to send; there is no preset window,
     * because a fixed "last few messages" was arbitrary -- what belongs in the
     * context is the reader's call, not a character count's.
     */
    /**
     * Above this many characters the panel advises splitting the work, without
     * blocking it: a long transcript is the reader's call, but a request past the
     * model's window fails, so silence would be unkind.
     */
    const CONTEXT_ADVICE_CHARS = 12000
    const CONTEXT_MODES = ['off', 'full']
    /** Character budget per mode; `Infinity` means "the reader decides". */
    const CONTEXT_BUDGET = { full: Infinity }
    /** Mirrors the Host's MAX_CONTEXT_CHARS; over it the Host keeps the head. */
    const CONTEXT_MAX_CHARS = 1_000_000

    let contextMode = readContext()
    const contextListeners = new Set()

    /** Read the stored mode; a blocked read keeps the private default (off). */
    function readContext() {
      try {
        const stored = globalThis.localStorage?.getItem(CONTEXT_KEY)
        // Older builds stored 'on'/'off', then 'excerpt'. Those names no longer
        // exist; falling back to `off` means an upgrade never widens what a
        // reader had agreed to send without them choosing it again.
        return CONTEXT_MODES.includes(stored) ? stored : 'off'
      } catch {
        return 'off'
      }
    }

    /** Store the mode; a blocked write only loses it for this page. */
    function setContext(next) {
      contextMode = CONTEXT_MODES.includes(next) ? next : 'off'
      try {
        globalThis.localStorage?.setItem(CONTEXT_KEY, contextMode)
      } catch {
        // Private mode or a full quota: the mode lasts for this page.
      }
      for (const notify of contextListeners) notify(contextMode)
    }

    /** The mode, read by the rewrite bar so a change applies to the next run. */
    function useContextSwitch() {
      const [mode, setMode] = React.useState(contextMode)
      React.useEffect(() => {
        contextListeners.add(setMode)
        return () => contextListeners.delete(setMode)
      }, [])
      return mode
    }

    /** Has the one-time welcome been dismissed in this browser? */
    let welcomed = readWelcomed()
    const welcomeListeners = new Set()

    function readWelcomed() {
      try {
        return globalThis.localStorage?.getItem(WELCOME_KEY) === 'done'
      } catch {
        return false
      }
    }

    function dismissWelcome() {
      welcomed = true
      try {
        globalThis.localStorage?.setItem(WELCOME_KEY, 'done')
      } catch {
        // Private mode: the hint stays dismissed for this page.
      }
      for (const notify of welcomeListeners) notify(true)
    }

    function useWelcomed() {
      const [done, setDone] = React.useState(welcomed)
      React.useEffect(() => {
        welcomeListeners.add(setDone)
        return () => welcomeListeners.delete(setDone)
      }, [])
      return done
    }

    /**
     * Answers already fetched, keyed by the exact request that produced them.
     *
     * Opening the summary, collapsing it and opening it again asks about the
     * same calls; so does switching a level away and back. Re-asking would cost
     * the same tokens for identical text, so the answer is kept. Bounded, since
     * a long session would otherwise grow this without limit.
     */
    const DETAIL_CACHE = new Map()
    const DETAIL_CACHE_MAX = 60

    /**
     * One request at a time. A ten-step summary would otherwise fire ten
     * concurrent calls at the same provider, which invites a rate limit that
     * fails all of them; serialising costs latency but never more tokens.
     * shortcut: strictly serial, so a long summary fills in slowly; add a small
     * concurrency cap if the wait becomes the complaint.
     */
    let detailQueue = Promise.resolve()

    /** Queue one explanation request behind the ones already waiting. */
    function queuedDetail(call, lang, signal, study) {
      const run = () => fetchDetail(call, lang, signal, study)
      const next = detailQueue.then(run, run)
      // Keep the chain alive even when a request rejects, or every later request
      // would inherit the failure.
      detailQueue = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    }

    /**
     * Model explanation for one call: `undefined` while asking, `''` when the
     * Host could not answer, and the text once it does. `study` rides along so
     * the Host can ask for the same depth the rule text would have shown.
     */
    function useModelDetail(call, enabled, lang, study) {
      const [text, setText] = React.useState(undefined)
      const name = enabled ? call.name : ''
      const argsRaw = enabled ? call.argsRaw : ''
      React.useEffect(() => {
        if (name === '') {
          setText(undefined)
          return undefined
        }
        const key = `${lang}\u0000${study}\u0000${name}\u0000${argsRaw}`
        const cached = DETAIL_CACHE.get(key)
        if (cached !== undefined) {
          setText(cached)
          return undefined
        }
        setText(undefined)
        const controller = new AbortController()
        let live = true
        void queuedDetail({ name, argsRaw }, lang, controller.signal, study).then((detail) => {
          // A failed request is not cached: the next open may well succeed.
          if (detail !== '') {
            if (DETAIL_CACHE.size >= DETAIL_CACHE_MAX) DETAIL_CACHE.clear()
            DETAIL_CACHE.set(key, detail)
          }
          if (live) setText(detail)
        })
        return () => {
          live = false
          controller.abort()
        }
      }, [name, argsRaw, lang, study])
      return text
    }

    /**
     * How much detail a rewrite should carry. Ordered shortest to fullest, and
     * the three must match the Host's `TONE` keys or a request is rejected.
     */
    const TONES = ['concise', 'balanced', 'detailed']

    /**
     * Rewrite one rough text into a clear instruction.
     *
     * Three states share one panel: the offer (a button while there is text to
     * rewrite), the result (the rewrite beside 采用 / 退回), and a small input
     * for "改得再短一点" style follow-ups. Nothing here sends the message:
     * `accept` hands the words back to whatever owns them and the reader still
     * presses Enter.
     *
     * `background` returns the conversation the reader agreed to send, read
     * when the button is pressed so a flip applies to the next run. A surface
     * with no conversation to offer (the question card, which is outside the
     * chat) leaves it out and shows no switch it could not honour.
     */
    /**
     * The chat-picking side panel.
     *
     * The composer card has no room for a long list, and a list squeezed into
     * 200px is what made a full conversation look truncated. The card stays one
     * row; the list gets the height of the window instead.
     */
    /**
     * What the picker shows and what a run would send.
     *
     * The Host transcript wins when it has content; the chat node window is only
     * what the UI has loaded, so it is the fallback. The recommendation follows
     * the model's own window when the Host reports one.
     */
    function buildPickContext({ mode, picked, history, fallbackItems, scope }) {
      if (mode === 'off') {
        return { text: '', items: [], auto: new Set(), budget: 0, chars: 0, chosen: [], recommended: 0, window: undefined, whole: false }
      }
      const fromHost = Array.isArray(history?.messages) ? history.messages : []
      const all =
        fromHost.length > 0
          ? fromHost.map((each, index) => ({
              who: each.who,
              text: each.text,
              // Keys are scoped to the session: switching sessions must not
              // carry the previous conversation's ticks over by index.
              key: scope === undefined ? `${index}:${each.who}` : `${scope}#${index}:${each.who}`,
              line: `${each.who === 'user' ? '用户' : '助手'}\n${each.text}`,
            }))
          : fallbackItems
      const auto = new Set(all.map((each) => each.key))
      const isOn = (item) => (item.key in picked ? picked[item.key] : auto.has(item.key))
      const items = all.filter(isOn)
      const recommended =
        typeof history?.contextWindow === 'number' && history.contextWindow > 0
          ? Math.floor(history.contextWindow * 0.6)
          : CONTEXT_ADVICE_CHARS
      return {
        text: items.map((item) => item.line).join('\n\n'),
        items: all,
        auto,
        budget: Infinity,
        // Which source this list came from: the whole log, or only the loaded
        // window. The note under the list has to say which, or it lies.
        whole: fromHost.length > 0,
        chosen: items,
        chars: items.reduce((sum, item) => sum + item.line.length + 2, 0),
        recommended,
        window: history?.contextWindow,
      }
    }

    function RewriteCard({ text, accept, background, history, dock, t, sessionId }) {
      const contextMode = useContextSwitch()
      const [tone, setTone] = React.useState('detailed')
      const [busy, setBusy] = React.useState(false)
      // After a few seconds the button's label alone stops reassuring anyone.
      const [slow, setSlow] = React.useState(false)
      // Set when the reader stops a run, so the card confirms it happened.
      const [stopped, setStopped] = React.useState(false)
      // The list is the tall part of the panel; once the picking is done it can
      // be folded away so it stops covering the composer.
      const [listOpen, setListOpen] = React.useState(true)
      const [offer, setOffer] = React.useState('')
      const [result, setResult] = React.useState('')
      const [note, setNote] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [ask, setAsk] = React.useState('')
      // Per-message overrides on top of the mode's preset: key -> true (ticked)
      // or false (unticked). Absent means "whatever the preset says".
      const [picked, setPicked] = React.useState({})
      const [ctxNote, setCtxNote] = React.useState('')
      // Off by default: a click stays a click unless the reader asks for more.
      const [rangeToNewest, setRangeToNewest] = React.useState(false)
      // The last message touched, so Shift can close a range against it.
      const [anchor, setAnchor] = React.useState('')
      const listRef = React.useRef(undefined)
      const abort = React.useRef(undefined)
      const runTicket = React.useRef(0)

      React.useEffect(() => () => abort.current?.abort(), [])
      React.useEffect(() => {
        if (!busy) {
          setSlow(false)
          return undefined
        }
        const id = setTimeout(() => setSlow(true), 6000)
        return () => clearTimeout(id)
      }, [busy])
      // The list opens at the newest message, which is what a reader picks from.
      React.useEffect(() => {
        const el = listRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [contextMode])

      /**
       * What this run would send as context, and what it is made of.
       *
       * Computed for the current mode and selection rather than remembered from
       * the last run, so the list, the counts and the request can never
       * disagree: all three read this one value.
       */
      const context = React.useMemo(
        () =>
          buildPickContext({
            mode: contextMode,
            picked,
            history,
            scope: sessionId,
            fallbackItems:
              typeof background === 'function' ? background(CONTEXT_BUDGET[contextMode]).items : [],
          }),
        // `text` is the draft and has nothing to do with the list; keeping it
        // here rebuilt the whole selection on every keystroke.
        [contextMode, background, picked, history, sessionId],
      )


      /** Is this message currently ticked? */
      const isPicked = (item) => (item.key in picked ? picked[item.key] : context.auto.has(item.key))

      /**
       * Tick or untick one message.
       *
       * Turning one on is refused when it would push the selection past the
       * mode's budget: the cap is what keeps one rewrite from sending an entire
       * session, so the UI states the limit rather than silently truncating.
       */
      const toggleItem = (item, on, shift) => {
        const from = context.items.findIndex((each) => each.key === item.key)
        const at = (key) => context.items.findIndex((each) => each.key === key)

        // Shift closes a range between the anchor and this message. It replaces
        // the selection so the boundary is unambiguous.
        if (shift === true && anchor !== '' && from >= 0) {
          const to = at(anchor)
          if (to >= 0) {
            const low = Math.min(from, to)
            const high = Math.max(from, to)
            // Every key is written, because an absent key falls back to the
            // mode's default (everything), which would undo the range.
            const next = {}
            for (const each of context.items) next[each.key] = false
            for (let index = low; index <= high; index += 1) next[context.items[index].key] = true
            setCtxNote('')
            setPicked(next)
            setAnchor(item.key)
            return
          }
        }

        // The toggle's one job: nothing ticked, so a click means "this and
        // everything after it", not just this line.
        if (on === true && rangeToNewest === true && context.chosen.length === 0 && from >= 0) {
          const next = {}
          for (const each of context.items) next[each.key] = false
          for (let index = from; index < context.items.length; index += 1) next[context.items[index].key] = true
          setCtxNote('')
          setPicked(next)
          setAnchor(item.key)
          return
        }

        setAnchor(item.key)
        const next = { ...picked, [item.key]: on }
        const onNow = (each) => (each.key in next ? next[each.key] : context.auto.has(each.key))
        const total = context.items
          .filter(onNow)
          .reduce((sum, each) => sum + each.line.length + 2, 0)
        if (total > context.budget) {
          setCtxNote(t('rewrite.contextOverBudget', { max: context.budget }))
          return
        }
        setCtxNote('')
        setPicked(next)
      }

      /** Tick as many messages as the budget allows, newest first. */
      const pickAll = () => {
        const next = {}
        let total = 0
        for (let index = context.items.length - 1; index >= 0; index -= 1) {
          const each = context.items[index]
          const fits = total + each.line.length + 2 <= context.budget
          next[each.key] = fits
          if (fits) total += each.line.length + 2
        }
        setCtxNote('')
        setPicked(next)
      }

      /** End the run in flight: nothing it answers may land afterwards. */
      const cancelRun = () => {
        runTicket.current += 1
        abort.current?.abort()
        setBusy(false)
      }

      /** Cancel, and tell the reader it was their doing rather than a failure. */
      const stopRun = () => {
        cancelRun()
        setStopped(true)
        setNote('')
      }

      /** Run one rewrite of `rough`; `instruction` carries a follow-up change. */
      const run = (rough, instruction) => {
        const source = rough.trim()
        if (source === '') return
        abort.current?.abort()
        const controller = new AbortController()
        abort.current = controller
        // A request that was already on its way when the reader moved on must
        // not drop its answer into the card later.
        const ticket = runTicket.current + 1
        runTicket.current = ticket
        setBusy(true)
        setStopped(false)
        setNote('')
        // A revision is judged against the answer already on screen; if it comes
        // back empty, that answer is still the best one the reader has and must
        // not be taken away. A first attempt has nothing to keep.
        const keeping = instruction === undefined ? '' : result
        void fetchRewrite(
          { text: source, tone, lang: langNow(), previous: keeping, instruction, context: context.text },
          controller.signal,
        ).then((next) => {
          if (controller.signal.aborted || ticket !== runTicket.current) return
          setBusy(false)
          if (next.text === '') {
            const why = t(REWRITE_REASON_KEY[next.reason] ?? 'rewrite.reason.provider')
            if (keeping === '') {
              // Nothing was on screen, so there is nothing to keep: clear and say so.
              setResult('')
              setNote(t('rewrite.failedWhy', { why }))
              return
            }
            // Keep the version the reader already had, and say the change did not
            // land rather than that the rewrite failed.
            setOffer(rough)
            setResult(keeping)
            setNote(t('rewrite.failedChangeWhy', { why }))
            return
          }
          setOffer(rough)
          setResult(next.text)
          // Collapsed by default: the change field is opt-in, not the main path.
          setOpen(false)
        })
      }

      // Nothing to rewrite: the surface stays out of the way.
      if (text.trim() === '' && result === '') return null
      return h(
        'div',
        { className: dock },
        h(
          'div',
          { className: 'dse-card' },
          h(
            'div',
            { className: 'dse-row dse-head' },
            h('span', { className: 'dse-strong' }, t('rewrite.title')),
            // Three levels, all visible: a cycle button hid the other options.
            h(
              'div',
              { className: 'dse-tones', role: 'group', 'aria-label': t('rewrite.toneAria') },
              TONES.map((each) =>
                h(
                  'button',
                  {
                    key: each,
                    type: 'button',
                    className: tone === each ? 'dse-btn dse-btn-on' : 'dse-btn',
                    'aria-pressed': tone === each,
                    disabled: busy,
                    onClick: () => setTone(each),
                  },
                  t(`rewrite.tone.${each}`),
                ),
              ),
            ),
            // Reading the conversation shares the title row: two stacked rows of
            // controls read as two separate panels, and this is one panel.
            background !== undefined &&
              h('span', { className: 'dse-context-label' }, t('rewrite.contextLabel')),
            background !== undefined &&
              h(
                'div',
                { className: 'dse-tones', role: 'group', 'aria-label': t('rewrite.contextLabel') },
                CONTEXT_MODES.map((each) =>
                  h(
                    'button',
                    {
                      key: each,
                      type: 'button',
                      className: contextMode === each ? 'dse-btn dse-btn-on' : 'dse-btn',
                      'aria-pressed': contextMode === each,
                      disabled: busy,
                      onClick: () => {
                        // A new mode means a new preset: drop the manual picks
                        // so a stale tick does not silently reshape the budget.
                        setPicked({})
                        setCtxNote('')
                        setContext(each)
                      },
                    },
                    t(`rewrite.context.${each}`),
                  ),
                ),
              ),
            h(
              'button',
              {
                type: 'button',
                // The same control flips to "stop" while a run is in flight: a
                // reader who is done waiting should not have to hunt for a
                // second button, and the ticket makes the abandoned answer land
                // nowhere.
                className: busy ? 'dse-toggle dse-head-go dse-stop' : 'dse-toggle dse-head-go',
                disabled: busy ? false : text.trim() === '',
                onClick: () => {
                  if (busy) {
                    stopRun()
                    return
                  }
                  run(text)
                },
              },
              busy ? t('rewrite.stop') : result === '' ? t('rewrite.go') : t('rewrite.again'),
            ),
          ),
          // "挑选聊天内容" is the picker: choosing it opens the list, choosing 不读
          // closes it, so there is no third control to explain.
          contextMode !== 'off' &&
            h(
              'div',
              { className: 'dse-context-body' },
              listOpen && h('div', { className: 'dse-context-hint' }, t(`rewrite.contextHint.${contextMode}`)),
              h(
                'div',
                { className: 'dse-context-countrow' },
                h(
                  'span',
                  { className: 'dse-context-count' },
                  context.items.length === 0
                    ? t('rewrite.contextEmpty')
                    : context.chosen.length === 0
                      ? t('rewrite.contextNoneSelected')
                      : t('rewrite.contextCountOpen', {
                          count: context.chosen.length,
                          total: context.items.length,
                          chars: context.chars,
                        }),
                ),
                context.items.length > 0 &&
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dse-context-fold',
                      'aria-expanded': listOpen,
                      onClick: () => setListOpen(!listOpen),
                    },
                    listOpen ? t('rewrite.contextCollapse') : t('rewrite.contextExpand'),
                  ),
              ),
              context.chars > CONTEXT_MAX_CHARS &&
                h('div', { className: 'dse-warn' }, t('rewrite.contextOverflow')),
              context.chars > context.recommended &&
                h('div', { className: 'dse-advice' }, t(
                  context.window === undefined ? 'rewrite.contextLong' : 'rewrite.contextLongWindow',
                  { chars: context.chars, max: context.recommended, window: context.window },
                )),
              listOpen && context.items.length > 0 &&
                h('div', { className: 'dse-context-note' }, t('rewrite.contextPickHint')),
              listOpen && context.items.length > 0 &&
                h(
                  'div',
                  { className: 'dse-context-listwrap' },
                  h(
                    'ul',
                    { className: 'dse-context-list', ref: listRef },
                    context.items.map((item) =>
                      h(
                        'li',
                        { key: item.key },
                        h(
                          'label',
                          {
                            className: 'dse-context-item',
                            onClick: (event) => {
                              if (event.shiftKey !== true) return
                              event.preventDefault()
                              toggleItem(item, true, true)
                            },
                          },
                          h('input', {
                            type: 'checkbox',
                            className: 'dse-context-check',
                            checked: isPicked(item),
                            disabled: busy,
                            onChange: (event) => toggleItem(item, event.target.checked),
                          }),
                          h('span', { className: 'dse-context-who' }, t(`rewrite.context.who.${item.who}`)),
                          h('span', { className: 'dse-context-text' }, item.text),
                        ),
                      ),
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dse-context-jump',
                      'aria-label': t('rewrite.contextJumpBottom'),
                      onClick: () => {
                        const el = listRef.current
                        if (el) el.scrollTop = el.scrollHeight
                      },
                    },
                    '↓',
                  ),
                ),
              listOpen && context.items.length > 0 &&
                h(
                  'div',
                  { className: 'dse-context-actions' },
                  h('button', { type: 'button', className: 'dse-btn', disabled: busy, onClick: pickAll }, t('rewrite.contextPickAll')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dse-btn',
                      disabled: busy,
                      onClick: () => {
                        setCtxNote('')
                        setPicked(Object.fromEntries(context.items.map((each) => [each.key, false])))
                      },
                    },
                    t('rewrite.contextPickNone'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dse-btn',
                      disabled: busy,
                      onClick: () => {
                        setCtxNote('')
                        setPicked({})
                      },
                    },
                    t('rewrite.contextReset'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: rangeToNewest ? 'dse-btn dse-btn-on' : 'dse-btn',
                      'aria-pressed': rangeToNewest,
                      disabled: busy,
                      onClick: () => setRangeToNewest(!rangeToNewest),
                    },
                    t('rewrite.rangeToggle'),
                  ),
                ),
              context.items.length > 0 &&
                rangeToNewest &&
                h('div', { className: 'dse-foot' }, t('rewrite.rangeOn')),
              context.items.length > 0 &&
                h(
                  'div',
                  { className: 'dse-foot' },
                  t(context.whole ? 'rewrite.contextScopeWhole' : 'rewrite.contextScope'),
                ),
              ctxNote !== '' && h('div', { className: 'dse-warn' }, ctxNote),
            ),
          note !== '' && h('div', { className: 'dse-warn' }, note),
          // These belong to the run, not to a result: a first attempt has no
          // result block at all, and that is exactly when Stop is used.
          busy && slow && h('div', { className: 'dse-foot' }, t('rewrite.slow')),
          !busy && stopped && h('div', { className: 'dse-foot' }, t('rewrite.stopped')),
          result !== '' &&
            h(
              'div',
              { className: 'dse-body' },
              h('div', { className: 'dse-rewrite' }, result),
              h(
                'div',
                { className: 'dse-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dse-btn dse-btn-primary',
                    onClick: () => {
                      accept(result)
                      setResult('')
                      setAsk('')
                      setOpen(false)
                      setNote('')
                    },
                  },
                  t('rewrite.accept'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dse-btn',
                    onClick: () => {
                      // Reverting is a decision: anything still in flight is no
                      // longer wanted, and must not reappear once it answers.
                      cancelRun()
                      setStopped(false)
                      // Put the words back exactly as they were before adopting.
                      if (offer !== '') accept(offer)
                      setResult('')
                      setAsk('')
                      setOpen(false)
                      setNote('')
                    },
                  },
                  t('rewrite.revert'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dse-btn', 'aria-expanded': open, onClick: () => setOpen(!open) },
                  open ? t('rewrite.hideChange') : t('rewrite.change'),
                ),
              ),
              open &&
                h(
                  'div',
                  { className: 'dse-ask' },
                  h('input', {
                    className: 'dse-input',
                    type: 'text',
                    value: ask,
                    placeholder: t('rewrite.changePlaceholder'),
                    'aria-label': t('rewrite.change'),
                    onChange: (event) => setAsk(event.target.value),
                    onKeyDown: (event) => {
                      // Enter here asks for another rewrite; it must not send the message.
                      if (event.key !== 'Enter' || event.nativeEvent?.isComposing === true) return
                      event.preventDefault()
                      event.stopPropagation()
                      if (ask.trim() === '' || busy) return
                      run(offer === '' ? text : offer, ask.trim())
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: busy ? 'dse-btn dse-stop' : 'dse-btn',
                      disabled: busy ? false : ask.trim() === '',
                      onClick: () => {
                        if (busy) {
                          stopRun()
                          return
                        }
                        run(offer === '' ? text : offer, ask.trim())
                      },
                    },
                    busy ? t('rewrite.stop') : t('rewrite.apply'),
                  ),
                ),
              h('div', { className: 'dse-foot' }, t('rewrite.footnote')),
            ),
        ),
      )
    }

    /**
     * Composer cell: the rewrite panel for whatever is in the draft right now.
     * A separate component so the bar keeps its own mount point and the shared
     * card can be reused elsewhere.
     */
    function RewriteBar({ useInput, useChat, inputActions, t, sessionId }) {
      const draft = useInput((input) => input.draft)
      const mode = useContextSwitch()
      // Only fetch the transcript once the reader has actually asked to read it.
      const history = useChatHistory(sessionId, mode !== 'off')
      // The node map, not `legacy.nodes`: the legacy projection stores each
      // node's `data` payload without its `kind`, so it cannot tell a user
      // message from an assistant step. `nodes.values()` is the same source the
      // step list and the approval dialog already read.
      const nodes = useChat((snapshot) => snapshot.nodes.values())
      // A fresh arrow here would invalidate the card's context memo on every
      // keystroke, which is what made long conversations lag.
      const background = React.useMemo(() => (maxChars) => excerptOf(nodes, maxChars), [nodes])
      return h(RewriteCard, {
        text: draft,
        history,
        accept: inputActions.setDraft,
        // The mode decides the budget, so the panel asks for what it will send.
        background,
        dock: 'dse-dock',
        t,
        sessionId,
      })
    }

    /**
     * The live answer box of an `ask_user_question` card, or null.
     *
     * The card belongs to the user-questions plugin and exposes no handle, so
     * the one stable thing about it is its markup: the card root carries
     * `data-question-key`, and the box inside it is a textarea that is enabled
     * while the reader may answer. A disabled box means the card is settled.
     * @param doc - the page document.
     * @returns the box and its card, or null when no card is open.
     */
    function questionSeat(doc) {
      const field = [...doc.querySelectorAll('[data-question-key] textarea')].find((each) => !each.disabled)
      const card = field?.closest('[data-question-key]') ?? null
      return field === undefined || card === null ? null : { field, card }
    }

    /**
     * Put `text` into the answer box the way typing would.
     *
     * The box is a React controlled textarea in another plugin, so its state is
     * only updated by React's own input handler: the native value setter (which
     * bypasses React's value tracking) followed by a bubbling `input` event.
     * @param field - the textarea to fill.
     * @param text - the whole answer, replacing what is there.
     * @returns whether the write happened; false on a page without textareas.
     */
    function writeAnswer(field, text) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set
      if (setter === undefined) return false
      setter.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }

    /**
     * The answer box of a live `ask_user_question` card.
     *
     * That card replaces the composer — and this plugin's dock with it — while
     * it is up, so the same rewrite panel is anchored to the box from the frame
     * overlay instead. It carries no conversation switch: the card is outside
     * the chat, and offering a switch it could not honour would be a lie.
     *
     * shortcut: the card exposes no seat, so its box is found by markup
     * (`[data-question-key] textarea`); if the shipped card changes those
     * attributes, this panel goes quiet instead of breaking it.
     */
    function QuestionRewrite({ t }) {
      const [seat, setSeat] = React.useState(null)
      const [value, setValue] = React.useState('')
      const [place, setPlace] = React.useState(null)
      React.useEffect(() => {
        if (globalThis.document === undefined) return undefined
        const sync = () => {
          const next = questionSeat(globalThis.document)
          setSeat((current) => (current?.field === next?.field ? current : next))
          setValue(next?.field.value ?? '')
          if (next === null) return
          const bounds = next.card.getBoundingClientRect()
          // Above the card, never taller than the room it has, so a tall card
          // cannot push the panel off the top of the window.
          const spot = {
            left: bounds.left,
            width: bounds.width,
            bottom: globalThis.innerHeight - bounds.top + 8,
            maxHeight: Math.max(120, bounds.top - 16),
          }
          setPlace((current) =>
            current !== null &&
            current.left === spot.left &&
            current.width === spot.width &&
            current.bottom === spot.bottom &&
            current.maxHeight === spot.maxHeight
              ? current
              : spot,
          )
        }
        sync()
        // Polled as well as listened to: the card is another plugin's DOM and
        // can mount, swap its box or close without firing a scroll or resize.
        // `input` is captured so the text is never a keystroke behind.
        const timer = setInterval(sync, 400)
        globalThis.document.addEventListener('input', sync, true)
        globalThis.addEventListener?.('scroll', sync, true)
        globalThis.addEventListener?.('resize', sync)
        return () => {
          clearInterval(timer)
          globalThis.document.removeEventListener('input', sync, true)
          globalThis.removeEventListener?.('scroll', sync, true)
          globalThis.removeEventListener?.('resize', sync)
        }
      }, [])
      if (seat === null || place === null) return null
      return h(
        'div',
        {
          className: 'dse-anchor',
          style: {
            left: `${place.left}px`,
            width: `${place.width}px`,
            bottom: `${place.bottom}px`,
            maxHeight: `${place.maxHeight}px`,
          },
        },
        h(RewriteCard, {
          text: value,
          accept: (next) => {
            if (writeAnswer(seat.field, next)) setValue(next)
          },
          dock: 'dse-float',
          t,
        }),
      )
    }

    function rootOf(nodes, callId) {
      for (const node of nodes) {
        if (node.kind !== 'tool-call') continue
        const root = node.data.root
        if (root !== undefined && root.callId === callId) return root
      }
      return undefined
    }

    // --- presentation ---------------------------------------------------
    const CSS = `
/* Every colour, radius and border comes from the host theme tokens, so the
   panel follows light/dark and the user's accent without a second stylesheet.
   The local tokens below are the only additions: a shadow soft enough to read
   as a surface on both themes, and the spacing rhythm the rows share. */
.dse-stack{--dse-gap:10px;--dse-radius:10px;--dse-pad:12px 14px;
  /* Derived from the label colour rather than a fixed rgba: in a light theme
     that is a dark shadow, in a dark theme it is a light halo, which is what
     elevation looks like there. A hardcoded dark shadow simply vanishes. */
  --dse-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent),
    0 4px 14px color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);
  --dse-ring:0 0 0 1px var(--dsw-alias-border-l1);
  display:flex;flex-direction:column;gap:var(--dse-gap);min-width:0;
  font-family:var(--dsw-font-family,inherit);word-break:normal;
  /* Native inputs and the select's dropdown chrome follow whatever the host
     declared, instead of defaulting to light widgets on a dark page. */
  color-scheme:inherit}
.dse-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));margin:0 auto}
/* The one-time introduction: a card, not a modal, so it never blocks the
   composer while the reader takes it in. */
.dse-welcome{padding:12px 14px}
.dse-welcome-list{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:21px;
  color:var(--dsw-alias-label-secondary)}
.dse-welcome-list li{margin:2px 0}
.dse-welcome .dse-foot{margin-top:8px}
.dse-card{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,748px) - 4 * var(--dsh-composer-dock-inset,8px));margin:0 auto;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dse-radius,10px);
  background:var(--dsw-alias-bg-layer-1);padding:var(--dse-pad,12px 14px);
  box-shadow:var(--dse-shadow,0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent))}
.dse-row{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
/* Side panel for the chat picker: full height, so a long list scrolls instead
   of being cut into a 200px box. */
/* The dot never travels alone: its word sits beside it, so the risk survives a
   colour-blind reader, a greyscale screenshot, or a bad monitor. */
.dse-risk{flex:none;display:inline-flex;align-items:center;gap:6px}
.dse-risk-text{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dse-dot{flex:none;width:7px;height:7px;border-radius:50%;align-self:center;
  /* A hairline in the label colour keeps the dot legible on both themes; the
     ring is a mix, not a fixed white, so it does not glow on a dark surface. */
  box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}
.dse-strong{flex:none;font-weight:600;letter-spacing:.01em}
.dse-muted{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dse-target{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-2);border-radius:5px;padding:1px 6px}
.dse-line{margin-top:6px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dse-line:first-child{margin-top:0}
/* Advice, not an error: long context is allowed, it just may not fit the model. */
.dse-advice{margin-top:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-warn-primary)}
.dse-warn{margin-top:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.dse-foot{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);
  padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
/* Reading the conversation shares the title row: one line of controls, not a
   second panel. Wrapping is allowed so a narrow card stacks instead of
   squeezing the buttons past the edge. */
.dse-head{flex-wrap:wrap;row-gap:6px}
.dse-head .dse-toggle{margin-left:0}
.dse-head .dse-head-go{margin-left:auto}
/* Same weight and colour as the panel's title: the two labels head two groups
   on one row, so they should read as peers rather than one label and one note. */
.dse-context-label{flex:none;font-size:12px;line-height:18px;font-weight:600;
  color:var(--dsw-alias-label-primary);
  margin-left:6px;padding-left:10px;border-left:1px solid var(--dsw-alias-border-l2)}
/* The expanded detail keeps its own surface, so the collapsed state stays a
   single clean row. */
.dse-context-body{margin-top:8px;padding:9px 11px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.dse-context-count{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.dse-context-countrow{display:flex;align-items:center;gap:8px;margin-top:4px}
.dse-context-countrow .dse-context-count{margin-top:0;flex:1;min-width:0}
.dse-context-fold{flex:none;cursor:pointer;font:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-brand-primary);border:1px solid transparent;border-radius:6px;
  background:none;padding:1px 6px}
.dse-context-fold:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.dse-context-fold:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dse-context-body{margin-top:2px}
.dse-context-note{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* The per-message picker: a reader can drop a line they would rather not send,
   which is the only manual control the budget allows. */
.dse-context-list{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;
  max-height:min(45vh,420px);overflow:auto}
.dse-context-item{display:flex;align-items:baseline;gap:8px;min-width:0;
  /* The right padding is the lane the jump-to-bottom button floats in. */
  padding:4px 30px 4px 6px;border-radius:6px;cursor:pointer}
.dse-context-item:hover{background:var(--dsw-alias-bg-layer-1)}
.dse-context-check{flex:none;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dse-context-who{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* The list is both the picker and the payload: it carries the message text
   itself, so there is no second preview repeating the same words below it. */
.dse-context-text{min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);
  white-space:pre-wrap;overflow-wrap:anywhere;max-height:54px;overflow:hidden}
.dse-context-reset{margin:6px 0 0;padding:0;font-size:12px}
.dse-context-listwrap{position:relative}
/* Pinned to the list's lower-right corner: the newest message is what a reader
   scrolls down for, and the corner is the one spot no row's text reaches. */
.dse-context-jump{position:absolute;right:6px;bottom:6px;width:26px;height:26px;
  display:flex;align-items:center;justify-content:center;
  border:1px solid var(--dsw-alias-border-l1);border-radius:50%;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  font-size:13px;line-height:1;cursor:pointer;padding:0;
  box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);
  transition:background-color .12s ease,color .12s ease}
.dse-context-jump:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dse-context-jump:disabled{opacity:.45;cursor:default}
.dse-context-jump:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dse-context-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.dse-context-actions .dse-btn{font-size:12px}
/* The notes block in the settings page: same row rhythm as the settings
   themselves, but prose with headings so it reads as documentation. */
.dse-docs{margin-top:10px;display:flex;flex-direction:column;gap:12px}
.dse-docs-item{padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2)}
.dse-docs-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dse-docs-body{margin-top:3px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.dse-tones{display:flex;gap:6px;flex-wrap:wrap;min-width:0;margin-left:auto}
.dse-tones .dse-btn{padding:3px 9px;font-size:12px}
.dse-toggle{margin-left:auto;flex:none;cursor:pointer;font:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-brand-primary);
  border:1px solid transparent;border-radius:6px;background:none;padding:2px 7px;
  transition:background-color .12s ease,border-color .12s ease}
.dse-toggle:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
/* Stopping is a secondary action: quieter than the blue "rewrite" label. */
.dse-toggle.dse-stop{color:var(--dsw-alias-label-secondary)}
.dse-btn.dse-stop{color:var(--dsw-alias-label-secondary)}
.dse-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:6px}
.dse-list{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}
.dse-list>li{display:flex;gap:10px;min-width:0;font-size:13px;line-height:20px}
.dse-list>li+li{padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
.dse-index{flex:none;min-width:20px;font-size:12px;line-height:20px;font-weight:600;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dse-body{min-width:0;flex:1}
.dse-code{display:block;margin-top:6px;font-family:var(--ds-font-family-code);font-size:12px;line-height:19px;
  color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;
  background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:7px 9px}
.dse-setting{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:18px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dse-setting-text{min-width:0}
.dse-setting-title{font-size:14px;line-height:21px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dse-setting-desc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dse-select{flex:none;max-width:min(360px,50%);box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  padding:6px 10px;font:inherit;font-size:13px;cursor:pointer;
  /* The host paints its own control chrome; without this the dropdown arrow is
     the OS one and stays dark-on-dark. */
  appearance:none;-webkit-appearance:none;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 15px) calc(50% + 1px),calc(100% - 10px) calc(50% + 1px);
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;
  padding-right:30px;
  transition:border-color .12s ease,background-color .12s ease}
.dse-select:hover{background:var(--dsw-alias-bg-layer-2)}
.dse-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dse-page{display:flex;flex-direction:column;max-width:760px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dse-page-head{margin-bottom:4px}
.dse-page-title{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em}
.dse-page-lead{margin:8px 0 4px;color:var(--dsw-alias-label-secondary);line-height:21px}
.dse-page-section{margin-top:24px;font-size:12px;line-height:18px;font-weight:600;
  color:var(--dsw-alias-label-tertiary);letter-spacing:.04em;text-transform:none}
.dse-page-about{margin-top:10px;color:var(--dsw-alias-label-secondary)}
.dse-page-about p{margin:0 0 8px}
.dse-page-cost{margin:10px 0 0;font-size:12px;line-height:19px;color:var(--dsw-alias-state-warn-primary);white-space:pre-wrap;overflow-wrap:anywhere;
  background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:9px 11px}
.dse-levels{flex:none;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:0}
.dse-levels-end{margin-left:auto}
/* Three level buttons are wider than the right-hand column at narrow widths,
   so this row stacks instead of squeezing them out of reach. */
.dse-setting-levels{align-items:flex-start;flex-wrap:wrap;gap:12px}
.dse-setting-levels .dse-levels{justify-content:flex-start;flex-grow:1}
.dse-full{margin-top:10px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dse-full-part+.dse-full-part{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
.dse-full-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:.01em}
.dse-full-body{margin-top:4px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dse-rewrite{margin-top:8px;max-height:220px;overflow:auto;font-size:13px;line-height:21px;
  color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;
  background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px}
/* Sits above a live question card, in the frame overlay layer: fixed so the
   card can scroll under it, and capped so a long answer never buries the card.
   The overlay already hands pointer events to its direct children. */
.dse-anchor{position:fixed;display:flex;justify-content:center;overflow:auto}
.dse-float{box-sizing:border-box;width:100%}
.dse-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.dse-btn{flex:none;cursor:pointer;font:inherit;font-size:12px;line-height:18px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  padding:4px 11px;
  transition:background-color .12s ease,border-color .12s ease,color .12s ease}
.dse-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.dse-btn:active:not(:disabled){transform:translateY(.5px)}
.dse-btn:disabled{opacity:.45;cursor:default}
.dse-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dse-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:500}
.dse-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
/* After .dse-btn on purpose: a same-specificity rule placed earlier would be
   overridden, and the picked level would look identical to the other two. */
.dse-btn.dse-btn-on{border-color:var(--dsw-alias-brand-primary);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-brand-primary);font-weight:600}
.dse-ask{display:flex;gap:8px;margin-top:10px}
.dse-input{min-width:0;flex:1;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  padding:7px 11px;font:inherit;font-size:13px;
  transition:border-color .12s ease,background-color .12s ease}
.dse-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dse-input:hover{border-color:var(--dsw-alias-border-l2)}
.dse-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:var(--dsw-alias-brand-primary)}
`
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-step-explain'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Risk dot. `label` names the level for screen readers where the colour is
     * the only carrier; the approval dialog passes none because it prints the
     * level as text right beside it.
     */
    function Dot({ risk, label }) {
      const style = { background: RISK_COLOUR[risk] }
      const dot = h('span', { className: 'dse-dot', style, 'aria-hidden': true })
      // The colour is the only carrier otherwise, which excludes anyone who
      // cannot tell these three hues apart; the word travels with the dot.
      if (label === undefined) return dot
      return h(
        'span',
        { className: 'dse-risk' },
        dot,
        h('span', { className: 'dse-risk-text' }, label),
      )
    }

    /**
     * The explanation itself, shared by the chat surfaces and the approval
     * dialog so the two can never drift apart again.
     *
     * `force` lets the approval dialog ask for a model explanation from its own
     * "model notes" level, independent of the global switch. Either way the
     * impact and undo lines stay local, because they are the facts the reader
     * decides on; a model that fails must never take them away.
     */
    function Explanation({ info, t, force }) {
      const level = useStudyLevel()
      const byModel = useExplainByModel()
      const parts = studyParts(level)
      const asked = (byModel || force === true) && info.tool !== ''
      const model = useModelDetail({ name: info.tool, argsRaw: info.argsRaw }, asked, langNow(), level)
      // Replace only once an answer actually arrived; `''` means it never will.
      const byModelText = asked && typeof model === 'string' && model !== ''
      return h(
        'div',
        {},
        byModelText
          ? h('div', { className: 'dse-line' }, clipModelLine(model))
          : h(
              'div',
              {},
              h('div', { className: 'dse-line' }, t('step.line', { now: info.now })),
              parts.includes('why') && h('div', { className: 'dse-line' }, t('why.line', { why: info.why })),
              parts.includes('plan') && h('div', { className: 'dse-line' }, t('next.line', { next: info.next })),
            ),
        // The waiting line sits under the rule text, so it reads as "more is
        // coming" rather than as the whole explanation. It names its trigger,
        // because two settings can start this request.
        asked && model === undefined && h('div', { className: 'dse-muted' }, t(force === true ? 'detail.waitingLevel' : 'detail.waiting')),
        // A failed request is not cached, so closing and reopening this step is a
        // real retry; say that instead of letting the wait line vanish silently.
        asked && model === '' && h('div', { className: 'dse-foot' }, t('detail.failed')),
        // Says which of the two wrote the explanation above, so a model line is
        // never mistaken for a rule.
        asked && byModelText && h('div', { className: 'dse-foot' }, t('detail.byModel')),
      )
    }

    /** The explanation plus the impact and undo lines every surface shows. */
    function Detail({ info, t }) {
      return h(
        'div',
        { className: 'dse-body' },
        h(Explanation, { info, t }),
        h('div', { className: 'dse-line' }, t('effect.line', { effect: info.effect })),
        h('div', { className: 'dse-line' }, t('undo.line', { undo: info.undo })),
      )
    }

    /**
     * The one-time introduction.
     *
     * Someone who has just installed and enabled the plugin has no reason to
     * know that the strip above the composer, the line under a turn and the
     * approval dialog all come from it. This says so once, then never again.
     */
    function Welcome({ t }) {
      const done = useWelcomed()
      if (done) return null
      return h(
        'div',
        { className: 'dse-dock' },
        h(
          'div',
          { className: 'dse-card dse-welcome' },
          h(
            'div',
            { className: 'dse-row' },
            h('span', { className: 'dse-strong' }, t('welcome.title')),
            h(
              'button',
              { type: 'button', className: 'dse-toggle dse-head-go', onClick: dismissWelcome },
              t('welcome.dismiss'),
            ),
          ),
          h(
            'ul',
            { className: 'dse-welcome-list' },
            ['live', 'turn', 'approval'].map((key) => h('li', { key }, t(`welcome.${key}`))),
          ),
          h('div', { className: 'dse-foot' }, t('welcome.foot')),
        ),
      )
    }

    /** Composer strip: the call running right now, one line until expanded. */
    function LiveStep({ useChat, t }) {
      const [open, setOpen] = React.useState(false)
      const running = useChat((snapshot) => snapshot.legacy.runningCalls)
      if (running.length === 0) return null
      const root = callOf(running[running.length - 1])
      const info = explain(root.name, root.argsRaw, t)
      return h(
        'div',
        { className: 'dse-dock' },
        h(
          'div',
          { className: 'dse-card' },
          h(
            'div',
            { className: 'dse-row' },
            h(Dot, { risk: info.risk, label: t(`risk.${info.risk}`) }),
            h('span', { className: 'dse-strong' }, t('live.prefix', { label: info.label })),
            info.target !== '' && h('span', { className: 'dse-target' }, info.target),
            h(
              'button',
              { type: 'button', className: 'dse-toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
              open ? t('toggle.less') : t('toggle.more'),
            ),
          ),
          open && h(Detail, { info, t }),
        ),
      )
    }

    /** Turn tail: what this turn did, expandable to each step in order. */
    function TurnSummary({ turn, useChat, t }) {
      const [open, setOpen] = React.useState(false)
      const nodes = useChat((snapshot) => snapshot.nodes.values())
      const turnNo = turn?.turn
      const steps = React.useMemo(() => stepsOf(nodes, turnNo, t), [nodes, turnNo, t])
      if (steps.length === 0) return null
      return h(
        'div',
        { className: 'dse-stack' },
        h(
          'div',
          { className: 'dse-row' },
          h('span', { className: 'dse-strong' }, t('turn.summary', { count: steps.length, parts: groupSteps(steps, t) })),
          h(
            'button',
            { type: 'button', className: 'dse-toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
            open ? t('toggle.less') : t('toggle.each'),
          ),
        ),
        open &&
          h(
            'ul',
            { className: 'dse-list' },
            steps.map((info, index) =>
              h(
                'li',
                { key: `${index}-${info.tool}` },
                h('span', { className: 'dse-index' }, `${index + 1}.`),
                h(
                  'div',
                  { className: 'dse-body' },
                  h(
                    'div',
                    { className: 'dse-row' },
                    h(Dot, { risk: info.risk, label: t(`risk.${info.risk}`) }),
                    h('span', { className: 'dse-strong' }, info.label),
                    info.target !== '' && h('span', { className: 'dse-target' }, info.target),
                  ),
                  h(Detail, { info, t }),
                ),
              ),
            ),
          ),
      )
    }

    /**
     * Settings page: everything this plugin lets a reader change, in one place.
     *
     * The General row stays (it is the quick path the README documents), and
     * this page is the fuller one — the same switches plus the explanation of
     * what each one does. Both read the same state, so they never disagree.
     */
    function SettingsPage({ t }) {
      const level = useDetailLevel()
      const study = useStudyLevel()
      const byModel = useExplainByModel()
      const context = useContextSwitch()
      const picker = useModelPicker()
      // The docs are collapsed until asked for: the page is a settings list, and
      // four paragraphs of prose above it would bury the controls.
      const [docsOpen, setDocsOpen] = React.useState(false)
      /** One labelled control in the page's row rhythm. */
      const row = (title, body, control, extra) =>
        h(
          'div',
          { className: extra === undefined ? 'dse-setting' : `dse-setting ${extra}` },
          h(
            'div',
            { className: 'dse-setting-text' },
            h('div', { className: 'dse-setting-title' }, title),
            h('div', { className: 'dse-setting-desc' }, body),
          ),
          control,
        )
      return h(
        'div',
        { className: 'dse-page' },
        h('div', { className: 'dse-page-head' }, h('h2', { className: 'dse-page-title' }, t('page.title'))),
        h('p', { className: 'dse-page-lead' }, t('page.lead')),

        h('div', { className: 'dse-page-section' }, t('page.section.explain')),
        row(
          t('page.level.title'),
          t('page.level.body'),
          // Three buttons beat a cycle here: the reader sees every level at once.
          h(
            'div',
            { className: 'dse-levels', role: 'group', 'aria-label': t('page.level.title') },
            LEVELS.map((each) =>
              h(
                'button',
                {
                  key: each,
                  type: 'button',
                  className: level.includes(each) ? 'dse-btn dse-btn-on' : 'dse-btn',
                  'aria-pressed': level.includes(each),
                  // Independent switches: any combination can be on.
                  onClick: () => setDetail(toggleLayer(level, each, LEVELS)),
                },
                t(`level.${each}`),
              ),
            ),
          ),
          'dse-setting-levels',
        ),

        row(
          t('page.study.title'),
          t(`page.study.body.${study.length === STUDY_LEVELS.length ? 'plan' : study[0] ?? 'now'}`),
          h(
            'div',
            { className: 'dse-levels', role: 'group', 'aria-label': t('page.study.title') },
            STUDY_LEVELS.map((each) =>
              h(
                'button',
                {
                  key: each,
                  type: 'button',
                  className: study.includes(each) ? 'dse-btn dse-btn-on' : 'dse-btn',
                  'aria-pressed': study.includes(each),
                  onClick: () => setStudy(toggleLayer(study, each, STUDY_LEVELS)),
                },
                t(`study.${each}`),
              ),
            ),
          ),
          'dse-setting-levels',
        ),

        h('div', { className: 'dse-page-section' }, t('page.section.model')),
        row(t('settings.title'), t(picker.description), picker.select(t)),
        row(
          t('page.modelExplain.title'),
          t('page.modelExplain.body'),
          h(
            'div',
            { className: 'dse-levels', role: 'group', 'aria-label': t('page.modelExplain.title') },
            [
              ['off', false],
              ['on', true],
            ].map(([key, value]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: byModel === value ? 'dse-btn dse-btn-on' : 'dse-btn',
                  'aria-pressed': byModel === value,
                  onClick: () => setExplain(value),
                },
                t(`page.modelExplain.${key}`),
              ),
            ),
          ),
          'dse-setting-levels',
        ),
        // The cost line is its own paragraph, so it is read before the switch is
        // flipped rather than after.
        h('p', { className: 'dse-page-cost' }, t('page.modelExplain.cost')),

        row(
          t('page.context.title'),
          t('page.context.body'),
          h(
            'div',
            { className: 'dse-levels', role: 'group', 'aria-label': t('page.context.title') },
            CONTEXT_MODES.map((key) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: context === key ? 'dse-btn dse-btn-on' : 'dse-btn',
                  'aria-pressed': context === key,
                  onClick: () => setContext(key),
                },
                t(`rewrite.context.${key}`),
              ),
            ),
          ),
          'dse-setting-levels',
        ),
        h('p', { className: 'dse-page-cost' }, t(`page.context.hint.${context}`)),

        // Why a doc section exists at all: the three modes, the tick list and
        // the character cap interact, and none of that is guessable from the
        // labels alone. It is one collapsed block, so it costs the page nothing
        // until someone asks.
        h('div', { className: 'dse-page-section' }, t('page.docs.title')),
        h(
          'div',
          { className: 'dse-page-about' },
          h('p', {}, t('page.docs.lead')),
          h(
            'button',
            {
              type: 'button',
              className: 'dse-btn',
              'aria-expanded': docsOpen,
              onClick: () => setDocsOpen(!docsOpen),
            },
            docsOpen ? t('page.docs.hide') : t('page.docs.show'),
          ),
          docsOpen &&
            h(
              'div',
              { className: 'dse-docs' },
              ['modes', 'pick', 'cap', 'where'].map((key) =>
                h(
                  'div',
                  { key, className: 'dse-docs-item' },
                  h('div', { className: 'dse-docs-title' }, t(`page.docs.${key}.title`)),
                  h('div', { className: 'dse-docs-body' }, t(`page.docs.${key}.body`)),
                ),
              ),
            ),
        ),

        h('div', { className: 'dse-page-section' }, t('page.section.about')),
        h(
          'div',
          { className: 'dse-page-about' },
          h('p', {}, t('page.about.privacy')),
          h('p', {}, t('page.about.boundary')),
        ),
      )
    }

    /** Approval dialog: the same explanation, plus what each answer does. */
    function ApprovalDetail({ callId, useChat, t }) {
      const root = useChat((snapshot) => rootOf(snapshot.nodes.values(), callId))
      const level = useDetailLevel()
      const call = callOf(root)
      if (root === undefined) return null
      const info = explain(call.name, call.argsRaw, t)
      // The command is what the user is being asked about, so it is never clipped.
      const command = info.cat === 'exec' ? commandOf(root) : ''
      return h(
        'div',
        { className: 'dse-stack' },
        h(
          'div',
          { className: 'dse-row' },
          h(Dot, { risk: info.risk }),
          h('span', { className: 'dse-strong' }, info.label),
          info.target !== '' && info.cat !== 'exec' && h('span', { className: 'dse-target' }, info.target),
          h('span', { className: 'dse-muted' }, t(`risk.${info.risk}`)),
          // All three visible at once. A cycle button showed only the current
          // level, so a first-time reader never learned the others existed.
          h(
            'div',
            { className: 'dse-levels dse-levels-end', role: 'group', 'aria-label': t('page.level.title') },
            LEVELS.map((each) =>
              h(
                'button',
                {
                  key: each,
                  type: 'button',
                  className: level.includes(each) ? 'dse-btn dse-btn-on' : 'dse-btn',
                  'aria-pressed': level.includes(each),
                  onClick: () => setDetail(toggleLayer(level, each, LEVELS)),
                },
                t(`detail.${each}`),
              ),
            ),
          ),
        ),
        // The approval dialog is where a command is decided, so it carries the
        // same explanation the chat surfaces do, from one shared component. The
        // "model notes" level forces a model explanation even when the global
        // switch is off; the switch turns it on for this dialog too.
        (level.includes('rule') || level.includes('model')) && h(Explanation, { info, t, force: level.includes('model') }),
        command !== '' && h('code', { className: 'dse-code' }, command),
        info.danger && h('div', { className: 'dse-warn' }, t('approval.danger')),
        // `full` spells out the dialog itself, on top of the rule text above.
        level.includes('full') && h(FullExplanation, { t, info }),
        h('div', { className: 'dse-line' }, t('approval.allow', { effect: t(`ok.${info.cat}`) })),
        h('div', { className: 'dse-line' }, t('approval.deny', { effect: t(`no.${info.cat}`) })),
        // Only claim a model wrote something when one actually did.
        h('div', { className: 'dse-foot' }, t('approval.footnote')),
      )
    }

    /**
     * The `full` level: the same dialog, described in five fixed parts, so a
     * reader meeting it for the first time knows what it is asking, why it
     * appeared, what each line is, and what each button really does.
     */
    function FullExplanation({ t, info }) {
      const parts = [
        ['purpose', t('full.purpose')],
        ['trigger', t('full.trigger')],
        ['shows', t('full.shows')],
        ['options', t('full.options')],
        ['caveat', t('full.caveat', { effect: t(`no.${info.cat}`) })],
      ]
      return h(
        'div',
        { className: 'dse-full' },
        parts.map(([key, body]) =>
          h(
            'div',
            { key, className: 'dse-full-part' },
            h('div', { className: 'dse-full-title' }, t(`full.${key}.title`)),
            h('div', { className: 'dse-full-body' }, body),
          ),
        ),
      )
    }

    /**
     * Settings row: pick the model that writes the detailed paragraph.
     *
     * The choice is per-browser and rides on each request, so this row needs no
     * Host service and no profile write: the same storage that remembers the
     * switch remembers the model. The catalog is read live, so a provider that
     * is added or removed shows up without reloading the page.
     */
    function SettingsRow({ t }) {
      const picker = useModelPicker()
      return h(
        'div',
        { className: 'dse-setting' },
        h(
          'div',
          { className: 'dse-setting-text' },
          h('div', { className: 'dse-setting-title' }, t('settings.title')),
          h('div', { className: 'dse-setting-desc', role: picker.alert ? 'alert' : undefined }, t(picker.description)),
        ),
        picker.select(t),
      )
    }

    // --- dictionaries ---------------------------------------------------
    const zh = {
      'cat.read.label': '读取文件',
      'cat.read.what': '打开这个文件，把内容读进上下文。',
      'cat.read.effect': '只读，不会改动文件。',
      'cat.read.undo': '没有副作用，不需要撤销。',
      'cat.search.label': '查找',
      'cat.search.what': '在工作区里按名字或内容找匹配的位置。',
      'cat.search.effect': '只读，不会改动文件。',
      'cat.search.undo': '没有副作用，不需要撤销。',
      'cat.write.label': '改动文件',
      'cat.write.what': '把新内容写进这个文件。',
      'cat.write.effect': '文件会被真的修改，旧内容被覆盖。',
      'cat.write.undo': '旧内容可以从版本管理里找回。',
      'cat.exec.label': '运行命令',
      'cat.exec.what': '在这台电脑上执行一条命令，它能做的事不受限制。',
      'cat.exec.effect': '命令会真的执行：可能改动磁盘、安装软件或联网。',
      'cat.exec.undo': '取决于命令本身，先看清它要做什么再决定。',
      'cat.net.label': '联网',
      'cat.net.what': '向外部服务发一次请求，取回网页或搜索结果。',
      'cat.net.effect': '请求内容会离开这台电脑。',
      'cat.net.undo': '不用撤销，但注意别把隐私内容发出去。',
      'cat.ask.label': '向你提问',
      'cat.ask.what': '模型缺一条信息，需要你来给。',
      'cat.ask.effect': '只是等你回答，不改动任何东西。',
      'cat.ask.undo': '不需要撤销。',
      'cat.control.label': '调整会话状态',
      'cat.control.what': '更新这次对话里的记录：待办、计划、目标或后台任务。',
      'cat.control.effect': '只影响对话记录，不动磁盘上的项目文件。',
      'cat.control.undo': '再操作一次就能改回来。',
      'tool.read': '读取文件',
      'tool.read_image': '查看图片',
      'tool.write': '写入文件',
      'tool.edit': '修改文件',
      'tool.glob': '按名字找文件',
      'tool.grep': '按内容搜索',
      'tool.pwsh': '运行 PowerShell 命令',
      'tool.bash': '运行 shell 命令',
      'tool.web_search': '搜索网页',
      'tool.web_fetch': '打开网页',
      'tool.present': '交付文件',
      'tool.ask_user_question': '向你确认',
      'tool.todo_write': '更新待办清单',
      'tool.skill': '加载技能说明',
      'tool.working_directory': '切换工作目录',
      'tool.terminal_open': '打开终端',
      'tool.terminal_send': '在终端里输入',
      'tool.job_output': '读取后台任务输出',
      'tool.schedule_create': '创建定时提醒',
      'tool.send_message': '给子代理发消息',
      'tool.subagent': '交给子代理处理',
      'risk.low': '低风险',
      'risk.medium': '需留意',
      'risk.high': '会动到数据',
      'live.prefix': '正在{label}',
      'toggle.more': '这是什么',
      'toggle.less': '收起',
      'toggle.each': '逐步展开',
      'effect.line': '影响：{effect}',
      'undo.line': '能否撤回：{undo}',
      'step.line': '当前在做什么：{now}',
      'why.line': '为什么这样做：{why}',
      'next.line': '下一步可能：{next}',
      'why.read': '通常是为了先把要改的东西看清楚，避免凭猜测动手。',
      'why.search': '通常是先定位相关位置，再决定读哪些、改哪些。',
      'why.write': '通常是把已经想清楚的改动落盘，让结果真正生效。',
      'why.exec': '通常是为了验证、构建或运行，用真实输出确认结果，而不是只靠推断。',
      'why.net': '通常是本机信息不够，需要取回外部资料再继续。',
      'why.ask': '通常是它自己无法替你决定，需要你补一条只有你知道的信息。',
      'why.control': '通常是先把进度记下来，方便后续步骤对齐。',
      'why.danger': '这条命令会删除或覆盖数据，通常是在做清理或重置；执行前务必看清目标。',
      'next.read': '下一步多半是继续读相关文件，或基于内容开始改动。',
      'next.search': '下一步多半是打开命中的文件，或换一组关键词再找。',
      'next.write': '下一步多半是运行测试或命令，确认这次改动没问题。',
      'next.exec': '下一步多半是看输出决定：通过就继续，报错就回来改。',
      'next.net': '下一步多半是用取回的内容继续推理，或再查一条补充信息。',
      'next.ask': '下一步要等你回答后才会继续。',
      'next.control': '下一步多半是接着推进这些记录里的任务。',
      'next.danger': '下一步取决于你答不答应；拒绝的话它通常会换个更安全的做法。',
      'turn.part': '{label} {count}',
      'turn.summary': '本轮 {count} 步 · {parts}',
      'approval.allow': '点“允许”：{effect}',
      'approval.deny': '点“拒绝”：{effect}',
      'approval.danger': '注意：这条命令里有删除或覆盖数据的写法，先看清楚它指向哪里。',
      'approval.footnote': '以上只是说明，不会替你选择。',
      'level.rule': '基础',
      'level.model': '模型补充',
      'level.full': '完整说明',
      'detail.rule': '基础',
      'detail.model': '模型补充',
      'detail.full': '完整说明',
      'detail.waiting': '正在由模型生成这一步的解释…',
      'detail.waitingLevel': '正在让模型补充这一档的说明…',
      'detail.byModel': '以上解释由模型生成，可能出错；影响与撤回两行始终来自本地规则。',
      'detail.failed': '模型这次没答上来，上面是本机规则的解释；收起再展开可以再试一次。',
      'full.purpose.title': '这个框是干什么的',
      'full.purpose': '模型想动你的文件或运行命令，但它自己不能决定，所以停下来问你。它只是请求，还没有执行；你不点，它就一直等着。',
      'full.trigger.title': '为什么会弹出来',
      'full.trigger': '凡是会改文件、执行命令、访问网络或动到你没明确允许的范围的操作，都会先到这里问一次。读文件这类只读操作通常不弹。',
      'full.shows.title': '框里这几行分别是什么',
      'full.shows': '最上面一句是它想做什么；中间是模型要用的工具名和原样的参数（命令、路径），也就是你真正在批准的东西；下面两行分别写清点「允许」和点「拒绝」各自会发生什么。',
      'full.options.title': '你能做的选择',
      'full.options': '两个字：允许或拒绝。允许只对这一次生效，同一个操作下次还会再问；拒绝这一步就不执行，模型会收到「没被同意」，可以换个办法继续。也可以直接不管它，等你处理。',
      'full.caveat.title': '注意',
      'full.caveat': '看清参数里的路径和命令再决定；判断以你自己看到的原文为准，本说明只是帮你看懂。拒绝不会撤销已经发生的事，只会挡住这一步：{effect}。',
      'page.title': '步骤说明',
      'page.lead': '把模型正在做的每一步翻成能看懂的中文，并在需要你批准时把审批框讲清楚。下面两项决定它说多少、用哪个模型。',
      'page.section.explain': '说明的详细程度',
      'page.study.title': '讲解深度',
      'page.study.body.now': '只说明当前这一步在做什么。',
      'page.study.body.why': '在「做什么」之外，再说明这类操作通常是为了什么。',
      'page.study.body.plan': '再加上下一步可能做什么，方便你跟着理解它的节奏。',
      'study.now': '做什么',
      'study.why': '为什么',
      'study.plan': '下一步',
      'page.level.title': '审批框里说多细',
      'page.level.body': '基础档只讲规则，不联网；模型补充档再多一段模型写的说明；完整说明档把审批框本身拆成五段讲清楚。只改说明文字，不改审批流程。',
      'page.section.model': '模型',
      'page.modelExplain.title': '由当前模型生成每一步的解释',
      'page.modelExplain.body': '开启后，聊天里每一步的展开说明、每轮汇总和审批框的解释文字都由当前模型生成。此时上面的「讲解深度」决定模型写多深，而不是切换本地文案。关闭时全部由本机规则生成，不联网。影响与撤回两行始终来自本地规则。',
      'page.modelExplain.on': '开启',
      'page.modelExplain.off': '关闭',
      'page.modelExplain.cost': '⚠ 会增加 token 消耗：开启后，每个工具调用都会单独发一次请求（工具名 + 参数原文 + 一句回答，上限 200 token），一轮里有 10 步就是 10 次。这些消耗计入你当前的模型额度，和聊天本身分开计算。看不清收益时建议先关着，只在审批框里用「模型补充」档。',
      'page.section.about': '关于',
      'page.context.title': '扩写时读取当前对话',
      'page.context.body': '选择扩写时是否读取当前对话：不读只发送你输入框里的那句话；挑选聊天内容会列出整段对话，由你逐段勾选。扩写面板上也有同样的选择，并可以预览实际会发送的内容，两处同步。',
      'page.context.hint.off': '当前：不读。只发送你输入框里的那句话。',
      'page.context.hint.full': '当前：挑选聊天内容。列出整段对话由你勾选，不设字数上限。',
      'page.docs.title': '功能说明',
      'page.docs.lead': '下面几项不太容易从标签上看出来，展开看一眼就够。',
      'page.docs.show': '展开说明',
      'page.docs.hide': '收起说明',
      'page.docs.modes.title': '「读取对话」的两个选择',
      'page.docs.modes.body': '不读：扩写只发送输入框里的那句话。挑选聊天内容：列出整段对话，默认全部勾选，你可以逐段取消，最终发送什么完全由勾选决定。',
      'page.docs.pick.title': '勾选决定发送范围',
      'page.docs.pick.body': '选「挑选聊天内容」后可以逐段勾选，选中的段落不必相邻。没勾的一律不发送。还有「全选」「清空」「恢复默认勾选」三个快捷操作。',
      'page.docs.cap.title': '字数上限',
      'page.docs.cap.body': '「挑选聊天内容」没有字数上限：你勾多少就带多少，插件不会裁剪任何一段。真正的天花板是模型自己的上下文长度，不是插件定的数字。',
      'page.docs.where.title': '内容发到哪里',
      'page.docs.where.body': '扩写是一次独立请求，和当前对话分开，不占用当前对话的上下文。选中的对话只在这次请求里发给当前模型，用于理解你指的是什么；插件不会把它写进文件或新的对话记录。不读时不会读取任何对话内容。',
      'page.about.privacy': '关闭「由当前模型生成每一步的解释」时，只有模型补充档会上网；打开后，任何一档都会把工具名和参数原文发给模型。影响与撤回两行始终来自本机规则。',
      'page.about.boundary': '这个插件只做解释：它不渲染允许/拒绝按钮，不拦截 Enter / Esc，也不会替你回答审批。',
      'settings.title': '步骤说明的详细版由哪个模型写',
      'settings.description': '保存到这台机器的配置里，重新进入设置页仍然生效。',
      'settings.followChat': '跟随聊天模型（默认）',
      'settings.saveFailed': '没保存成功，仍然沿用上一次的设置，请稍后再试。',
      'settings.unavailable': '读不到已保存的设置，暂时只能跟随聊天模型。',
      'welcome.title': '步骤解释已开启',
      'welcome.live': '输入框上方：AI 正在做的那一步，一行中文。',
      'welcome.turn': '每轮说完：这一轮一共做了哪几步。',
      'welcome.approval': '弹出审批框：点「允许」或「拒绝」分别会怎样。',
      'welcome.foot': '随时可以在「设置 → 步骤说明」里调整；不想用了，在插件管理里停用。',
      'welcome.dismiss': '知道了',
      'rewrite.title': '把这句话写清楚',
      'rewrite.go': '帮我扩写',
      'rewrite.again': '重新扩写',
      'rewrite.stop': '停止扩写',
      'rewrite.slow': '还在改写…内容多的时候会慢一些，最多等一分多钟。',
      'rewrite.stopped': '已停止，原文没有动。',
      'rewrite.toneAria': '改写篇幅',
      'rewrite.tone.concise': '简短',
      'rewrite.tone.balanced': '适中',
      'rewrite.tone.detailed': '详细',
      'rewrite.accept': '采用',
      'rewrite.revert': '退回',
      'rewrite.change': '让它改',
      'rewrite.hideChange': '收起',
      'rewrite.changePlaceholder': '例如：再短一点 / 补上验收标准',
      'rewrite.apply': '改一版',
      'rewrite.failedWhy': '这次没改成功：{why}。原文没有动，可以再试一次。',
      'rewrite.failedChangeWhy': '这次改动没成功：{why}。上一版还在，可以再试一次。',
      'rewrite.reason.timeout': '等太久了，模型还没写完',
      'rewrite.reason.noModel': '没有可用的模型',
      'rewrite.reason.provider': '模型服务这次没回应',
      'rewrite.reason.offline': '连不上服务',
      'rewrite.reason.empty': '模型什么都没返回',
      'rewrite.footnote': '只是帮你把话说清楚：采用后才写进输入框，发送仍然由你按。',
      'rewrite.contextLabel': '读取对话',
      'rewrite.context.off': '不读',
      'rewrite.context.full': '挑选聊天内容',
      'rewrite.contextHint.off': '只发送你输入框里的那句话，不读取对话内容。',
      'rewrite.contextHint.full': '下面是整段对话，默认全部勾选；可以逐段取消，不设字数上限。',
      'rewrite.contextCountOpen': '已选 {count}/{total} 段，约 {chars} 字（不限字数）。',
      'rewrite.contextCollapse': '收起',
      'rewrite.contextExpand': '展开',
      'rewrite.contextEmpty': '当前对话还没有可读取的消息。',
      'rewrite.contextPickHint': '逐段勾选要发送的内容，可以不连续；未勾选的一律不发送。',
      'rewrite.contextLong': '这次大约 {chars} 字，偏长：超过模型能读的长度时，这次扩写会失败。建议只勾最近几段，或分几次扩写。',
      'rewrite.contextLongWindow': '这次大约 {chars} 字。你选的模型窗口约 {window} token，建议不超过 {max} 字；超了这次扩写可能失败。',
      'rewrite.contextScope': '列表里只有聊天中已经加载出来的部分；想选更早的内容，先把聊天往上滚一滚，再打开这里。',
      'rewrite.contextScopeWhole': '列表是整段对话，包含已经被压缩掉、模型已经看不到的早期消息。',
      'rewrite.contextOverflow': '内容超过 100 万字符，服务端只会保留前 100 万，超出的部分不会发送。',
      'rewrite.contextPickAll': '全选',
      'rewrite.contextJumpBottom': '回到最新一条',
      'rewrite.contextPickNone': '清空',
      'rewrite.contextReset': '恢复默认勾选',
      'rewrite.rangeToggle': '点一条选到最新',
      'rewrite.rangeOn': '已开启：先点「清空」，再点任意一条，会从这条一直选到最新；按住 Shift 点另一条，则选中两条之间的范围。',
      'rewrite.contextOverBudget': '再加这一段就超过 {max} 字上限了。先取消别的段。',
      'rewrite.contextNoneSelected': '未选任何对话，这次只发送输入框里的那句话。',
      'rewrite.context.who.user': '你',
      'rewrite.context.who.assistant': '助手',
      'ok.read': '内容会被读进上下文，文件本身不动。',
      'ok.search': '会执行一次只读查找。',
      'ok.write': '文件会被真的改写。',
      'ok.exec': '命令会真的执行，可能改动磁盘。',
      'ok.net': '请求会发出去，内容离开本机。',
      'ok.ask': '问题会显示给你。',
      'ok.control': '只更新对话里的记录。',
      'no.read': '读不到这个文件，模型会换别的办法。',
      'no.search': '这次查找不执行。',
      'no.write': '文件保持原样，一个字都不改。',
      'no.exec': '命令不执行，不会有任何副作用。',
      'no.net': '请求不发出，内容不会离开本机。',
      'no.ask': '不会向你提问。',
      'no.control': '记录保持不变。',
    }
    const en = {
      'cat.read.label': 'Read a file',
      'cat.read.what': 'Opens this file and puts its contents into the conversation.',
      'cat.read.effect': 'Read-only; the file is not changed.',
      'cat.read.undo': 'Nothing to undo, there is no side effect.',
      'cat.search.label': 'Search',
      'cat.search.what': 'Looks through the workspace for names or text that match.',
      'cat.search.effect': 'Read-only; the file is not changed.',
      'cat.search.undo': 'Nothing to undo, there is no side effect.',
      'cat.write.label': 'Change a file',
      'cat.write.what': 'Writes new content into this file.',
      'cat.write.effect': 'The file really changes; the old content is overwritten.',
      'cat.write.undo': 'The old content can come back from version control.',
      'cat.exec.label': 'Run a command',
      'cat.exec.what': 'Runs a command on this machine; what it can do is not limited.',
      'cat.exec.effect': 'The command really runs: it may change disks, install software or use the network.',
      'cat.exec.undo': 'Depends on the command; read what it does before deciding.',
      'cat.net.label': 'Use the network',
      'cat.net.what': 'Sends one request to an outside service to fetch a page or search results.',
      'cat.net.effect': 'The request content leaves this machine.',
      'cat.net.undo': 'Nothing to undo, but do not send private content.',
      'cat.ask.label': 'Ask you',
      'cat.ask.what': 'The model needs one piece of information only you have.',
      'cat.ask.effect': 'It only waits for your answer; nothing changes.',
      'cat.ask.undo': 'Nothing to undo.',
      'cat.control.label': 'Adjust conversation state',
      'cat.control.what': 'Updates records in this conversation: to-dos, plans, goals or background jobs.',
      'cat.control.effect': 'Only conversation records change; project files on disk do not.',
      'cat.control.undo': 'Doing it again changes it back.',
      'tool.read': 'Read a file',
      'tool.read_image': 'Look at an image',
      'tool.write': 'Write a file',
      'tool.edit': 'Edit a file',
      'tool.glob': 'Find files by name',
      'tool.grep': 'Search file contents',
      'tool.pwsh': 'Run a PowerShell command',
      'tool.bash': 'Run a shell command',
      'tool.web_search': 'Search the web',
      'tool.web_fetch': 'Open a web page',
      'tool.present': 'Hand over files',
      'tool.ask_user_question': 'Check with you',
      'tool.todo_write': 'Update the to-do list',
      'tool.skill': 'Load skill instructions',
      'tool.working_directory': 'Change working directory',
      'tool.terminal_open': 'Open a terminal',
      'tool.terminal_send': 'Type into a terminal',
      'tool.job_output': 'Read background job output',
      'tool.schedule_create': 'Create a reminder',
      'tool.send_message': 'Message a subagent',
      'tool.subagent': 'Hand off to a subagent',
      'risk.low': 'low risk',
      'risk.medium': 'worth a look',
      'risk.high': 'touches data',
      'live.prefix': '{label}…',
      'toggle.more': 'What is this?',
      'toggle.less': 'Collapse',
      'toggle.each': 'Step by step',
      'effect.line': 'Effect: {effect}',
      'undo.line': 'Reversible: {undo}',
      'step.line': 'What it is doing: {now}',
      'why.line': 'Why this step: {why}',
      'next.line': 'Likely next: {next}',
      'why.read': 'Usually to see what is there before changing anything, rather than acting on a guess.',
      'why.search': 'Usually to locate the relevant spots first, then decide what to read and what to change.',
      'why.write': 'Usually to put a change that is already worked out onto disk, so it actually takes effect.',
      'why.exec': 'Usually to verify, build or run, confirming the result from real output instead of assuming it.',
      'why.net': 'Usually because this machine does not hold the answer, so outside material is fetched first.',
      'why.ask': 'Usually because it cannot decide for you and needs one fact only you know.',
      'why.control': 'Usually to record progress so later steps stay aligned.',
      'why.danger': 'This command deletes or overwrites data, usually as cleanup or a reset; read the target before allowing it.',
      'next.read': 'Most likely it keeps reading related files, or starts changing something based on them.',
      'next.search': 'Most likely it opens a matched file, or searches again with different words.',
      'next.write': 'Most likely it runs a test or command to confirm this change is sound.',
      'next.exec': 'Most likely it reads the output and decides: carry on if it passes, come back and fix it if not.',
      'next.net': 'Most likely it continues from what came back, or fetches one more piece of information.',
      'next.ask': 'It waits for your answer before going on.',
      'next.control': 'Most likely it carries on with the tasks recorded there.',
      'next.danger': 'What happens next depends on your answer; if you reject it, it usually finds a safer way.',
      'turn.part': '{label} {count}',
      'turn.summary': '{count} steps this turn · {parts}',
      'approval.allow': 'Allow: {effect}',
      'approval.deny': 'Reject: {effect}',
      'approval.danger': 'Careful: this command deletes or overwrites data. Check exactly what it points at.',
      'approval.footnote': 'This is only an explanation and never answers for you.',
      'level.rule': 'Basic',
      'level.model': 'Model notes',
      'level.full': 'Full',
      'detail.rule': 'Basic',
      'detail.model': 'Model notes',
      'detail.full': 'Full',
      'detail.waiting': 'Asking the model to write this step’s explanation…',
      'detail.waitingLevel': 'Asking the model for this level’s note…',
      'detail.byModel': 'The explanation above was written by a model and may be wrong; the impact and reversible lines always come from local rules.',
      'detail.failed': 'The model did not answer this time; the rule-based explanation above stands. Collapse and reopen this step to try again.',
      'full.purpose.title': 'What this box is',
      'full.purpose': 'The model wants to touch your files or run a command, and it cannot decide that alone, so it stops and asks you. Nothing has happened yet; until you answer, it waits.',
      'full.trigger.title': 'Why it appeared',
      'full.trigger': 'Anything that writes files, runs commands, reaches the network, or goes beyond what you clearly allowed comes here for one answer. Plain reads usually do not ask.',
      'full.shows.title': 'What each line is',
      'full.shows': 'The first line says what it wants to do. Below that is the tool name and the arguments exactly as the model sent them (the command, the path) — that is what you are approving. The next two lines say what allowing and rejecting each do.',
      'full.options.title': 'What you can choose',
      'full.options': 'Two answers: allow or reject. Allowing covers this one time only; the same action asks again next time. Rejecting skips this step, and the model is told it was not approved, so it can try another way. You can also leave the box alone and answer later.',
      'full.caveat.title': 'Worth knowing',
      'full.caveat': 'Read the path and the command before deciding, and trust the original text over this explanation. Rejecting does not undo what already happened; it only stops this step: {effect}.',
      'page.title': 'Step explanation',
      'page.lead': 'Turns each step the model takes into plain language, and explains the approval box when your answer is needed. The two settings below decide how much it says and which model writes it.',
      'page.section.explain': 'How much it explains',
      'page.study.title': 'Explanation depth',
      'page.study.body.now': 'Names what the current step is doing.',
      'page.study.body.why': 'Adds what this kind of step is usually for.',
      'page.study.body.plan': 'Also adds what commonly comes next, so you can follow its rhythm.',
      'study.now': 'What',
      'study.why': 'Why',
      'study.plan': 'Next',
      'page.level.title': 'How detailed the approval notes are',
      'page.level.body': 'Basic is rule text only and never goes online. Model notes adds one model-written paragraph. Full spells out the approval box itself in five parts. All three change the words only, never the approval flow.',
      'page.section.model': 'Model',
      'page.modelExplain.title': 'Have the current model write each step’s explanation',
      'page.modelExplain.body': 'When on, the explanation for every expanded step, every turn summary and the approval dialog is written by the current model. The explanation depth above then decides how deep the model writes, rather than switching between local texts. When off, everything comes from local rules with no network call. The impact and reversible lines always come from local rules.',
      'page.modelExplain.on': 'On',
      'page.modelExplain.off': 'Off',
      'page.modelExplain.cost': '⚠ This costs tokens: with it on, every tool call sends its own request (tool name + raw arguments + one short answer, capped at 200 tokens), so a ten-step turn is ten requests. That spend counts against your current model quota and is billed separately from the chat itself. Leave it off unless the extra line earns its cost, or use the Model notes level in the approval dialog instead.',
      'page.section.about': 'About',
      'page.context.title': 'Read the current conversation when rewriting',
      'page.context.body': 'Whether a rewrite reads the current conversation: none sends only the sentence in your composer, and Pick chat lists the whole conversation for you to tick through. The rewrite panel offers the same choice and can preview exactly what would be sent; the two stay in sync.',
      'page.context.hint.off': 'Now: none. Only the sentence in your composer is sent.',
      'page.context.hint.full': 'Now: Pick chat. The whole conversation, ticked by you, with no character cap.',
      'page.docs.title': 'How this works',
      'page.docs.lead': 'A few things here do not follow from the labels alone. One click explains them.',
      'page.docs.show': 'Show the notes',
      'page.docs.hide': 'Hide the notes',
      'page.docs.modes.title': 'The two "Read chat" choices',
      'page.docs.modes.body': 'None sends only the sentence in your composer. Pick chat lists the whole conversation, ticks everything by default, and lets you untick anything; what is sent is exactly what stays ticked.',
      'page.docs.pick.title': 'The ticks decide what is sent',
      'page.docs.pick.body': 'Choose Pick chat to tick passages one by one; they need not be adjacent. Anything unticked is never sent. Tick all, Clear and Restore the default ticks are shortcuts for the whole list.',
      'page.docs.cap.title': 'The character cap',
      'page.docs.cap.body': 'Pick chat has no cap: it sends as much as you tick and never trims a passage. The real ceiling is the model\'s own context window, not a number this plugin invents.',
      'page.docs.where.title': 'Where the text goes',
      'page.docs.where.body': 'A rewrite is its own request, separate from the current conversation, so it does not consume that conversation\'s context. The ticked passages are sent to the current model for this one rewrite only; the plugin never writes them to a file or a chat record. In None nothing is read at all.',
      'page.about.privacy': 'With "Have the current model write each step’s explanation" off, only the model-notes level goes online; with it on, every level sends the tool name and its arguments to the model. The impact and reversible lines always come from local rules.',
      'page.about.boundary': 'This plugin only explains: it renders no allow or reject control, does not intercept Enter or Escape, and never answers an approval for you.',
      'settings.title': 'Model that writes the detailed step explanation',
      'settings.description': 'Saved to this machine, so it survives leaving and reopening Settings.',
      'settings.followChat': 'Follow the chat model (default)',
      'settings.saveFailed': 'That did not save, so the previous choice is still in effect. Try again.',
      'settings.unavailable': 'The saved setting could not be read, so the chat model is used for now.',
      'welcome.title': 'Step Explain is on',
      'welcome.live': 'Above the composer: the step the AI is on, in one line.',
      'welcome.turn': 'After each turn: everything that turn did, step by step.',
      'welcome.approval': 'In an approval dialog: what Allow or Reject each lead to.',
      'welcome.foot': 'Change any of this in Settings → Step Explain; to stop using it, disable the plugin in plugin management.',
      'welcome.dismiss': 'Got it',
      'rewrite.title': 'Say it clearly',
      'rewrite.go': 'Rewrite',
      'rewrite.again': 'Rewrite again',
      'rewrite.stop': 'Stop',
      'rewrite.slow': 'Still rewriting… a long conversation takes longer; it gives up after about a minute.',
      'rewrite.stopped': 'Stopped. Your text is untouched.',
      'rewrite.toneAria': 'Rewrite length',
      'rewrite.tone.concise': 'Short',
      'rewrite.tone.balanced': 'Medium',
      'rewrite.tone.detailed': 'Full',
      'rewrite.accept': 'Use it',
      'rewrite.revert': 'Revert',
      'rewrite.change': 'Ask for a change',
      'rewrite.hideChange': 'Hide',
      'rewrite.changePlaceholder': 'e.g. shorter / add how to verify',
      'rewrite.apply': 'Rewrite it',
      'rewrite.failedWhy': 'That rewrite did not come back: {why}. Your text is untouched, so you can try again.',
      'rewrite.failedChangeWhy': 'That change did not come back: {why}. Your previous version is still here.',
      'rewrite.reason.timeout': 'that took too long and the model was still writing',
      'rewrite.reason.noModel': 'no model is available',
      'rewrite.reason.provider': 'the model service did not answer',
      'rewrite.reason.offline': 'the service could not be reached',
      'rewrite.reason.empty': 'the model returned nothing',
      'rewrite.footnote': 'This only words it better: nothing reaches the draft until you accept, and you still send it.',
      'rewrite.contextLabel': 'Read chat',
      'rewrite.context.off': 'None',
      'rewrite.context.full': 'Pick chat',
      'rewrite.contextHint.off': 'Only the sentence in your composer is sent; the conversation is not read.',
      'rewrite.contextHint.full': 'The whole conversation is listed below, ticked by default; untick anything, with no character cap.',
      'rewrite.contextCountOpen': '{count}/{total} selected, about {chars} characters (no cap).',
      'rewrite.contextCollapse': 'Collapse',
      'rewrite.contextExpand': 'Expand',
      'rewrite.contextEmpty': 'This conversation has no messages to read yet.',
      'rewrite.contextPickHint': 'Tick the passages to send; they need not be adjacent. Anything unticked is never sent.',
      'rewrite.contextLong': 'About {chars} characters, which is a lot: a request past what the model can read will fail. Tick fewer recent passages, or split the rewrite into a few runs.',
      'rewrite.contextLongWindow': 'About {chars} characters. The model you picked has a window of roughly {window} tokens, so keep it under {max} characters; past that the rewrite may fail.',
      'rewrite.contextScope': 'Only the part of the chat already loaded is listed. To pick older messages, scroll the chat up first, then open this list.',
      'rewrite.contextScopeWhole': 'The list is the whole conversation, including early messages that compaction already hid from the model.',
      'rewrite.contextOverflow': 'Over 1,000,000 characters: the server keeps the first million and drops the rest.',
      'rewrite.contextPickAll': 'Tick all',
      'rewrite.contextJumpBottom': 'Jump to the newest',
      'rewrite.contextPickNone': 'Clear',
      'rewrite.contextReset': 'Restore the default ticks',
      'rewrite.rangeToggle': 'Click one, pick to newest',
      'rewrite.rangeOn': 'On: press Clear, then click any message to tick it through the newest. Shift-click another message to tick the range between the two.',
      'rewrite.contextOverBudget': 'Adding that passage would pass the {max}-character cap. Untick another first.',
      'rewrite.contextNoneSelected': 'Nothing is ticked, so only the sentence in your composer will be sent.',
      'rewrite.context.who.user': 'You',
      'rewrite.context.who.assistant': 'Assistant',
      'ok.read': 'the contents are read in; the file itself is untouched.',
      'ok.search': 'one read-only search runs.',
      'ok.write': 'the file really gets rewritten.',
      'ok.exec': 'the command really runs and may change the disk.',
      'ok.net': 'the request goes out and leaves this machine.',
      'ok.ask': 'the question is shown to you.',
      'ok.control': 'conversation records are updated.',
      'no.read': 'the file stays unread and the model tries something else.',
      'no.search': 'this search does not run.',
      'no.write': 'the file stays exactly as it is.',
      'no.exec': 'the command does not run and has no side effect.',
      'no.net': 'the request never leaves this machine.',
      'no.ask': 'you are not asked.',
      'no.control': 'the records stay as they are.',
    }

    /** Client plugin: three read-only surfaces, no Host service, no approval answer. */
    function apply(ctx) {
      // The model answers in the reader's language, so ask the live locale once
      // per request instead of duplicating the preference.
      const locale = ctx.get('locale')
      langNow = () => (String(locale?.getLocale?.()?.active ?? '').startsWith('zh') ? 'zh' : 'en')
      // The settings row offers the models this profile can actually reach. The
      // Remote is looked up per call: it may mount after this plugin, and a page
      // without it still explains by rule text.
      catalogNow = async () => {
        const answer = await ctx.get('remote.session')?.modelCatalog?.()
        return answer?.ok === true ? answer.value : undefined
      }
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'step-explain: dictionaries')
      // The nav label is a thunk, so it follows the active locale without
      // re-registering the page.
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'step-explain-welcome', order: 20, locale: NS }, Welcome),
      )
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'step-explain', order: 30, locale: NS }, LiveStep),
      )
      // Same dock, its own cell: the rewrite offer sits beside the live step.
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'step-explain-rewrite', order: 40, locale: NS }, RewriteBar),
      )
      // A live `ask_user_question` card replaces the composer, so the dock above
      // is gone while the reader is typing an answer. The frame overlay is the
      // one seat that survives that, and the card has no seat of its own.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'step-explain-question', order: 20, locale: NS }, QuestionRewrite),
      )
      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'step-explain', order: 10, locale: NS }, TurnSummary),
      )
      // A single slot renders its LOWEST priority entry, so reaching this dialog
      // means going below the shipped row at 0 — and therefore replacing it,
      // which is why the cell repeats the command itself. If it throws, the slot
      // abdicates and the shipped row comes back.
      // shortcut: a plugin that also claims this type below -10 wins the cell;
      // upgrade if the runner exposes a stable cross-page rank to negotiate.
      ctx.slots.inject('conversation.approval.detail', () =>
        ctx.slots.register({ name: 'conversation.approval.detail', priority: -10, locale: NS }, ApprovalDetail),
      )
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register({ name: 'settings.general.item', id: 'step-explain', order: 95, locale: NS }, SettingsRow),
      )
      // Its own page, beside the shipped ones, for the reader who wants the
      // fuller explanation of each setting rather than one row.
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'step-explain', order: 37, label: () => t('page.title'), locale: NS },
          SettingsPage,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      __test: {
        explain,
        groupSteps,
        stepsOf,
        callOf,
        commandOf,
        rootOf,
        readDetail,
        detailPayload,
        pickDetail,
        setDetail,
        LEVELS,
        readStudy,
        setStudy,
        studyParts,
        STUDY_LEVELS,
        readExplain,
        setExplain,
        readContext,
        setContext,
        transcriptOf,
        excerptOf,
        CONTEXT_MODES,
        CONTEXT_BUDGET,
        Detail,
        Welcome,
        dismissWelcome,
        readWelcomed,
        Explanation,
        clipModelLine,
        loadModel,
        saveModel,
        setModel,
        fetchRewrite,
        NS,
        zh,
        en,
        LiveStep,
        TurnSummary,
        ApprovalDetail,
        SettingsPage,
        SettingsRow,
        RewriteBar,
        RewriteCard,
        buildPickContext,
        shouldReadTranscript,
        rewriteWaitFor,
        historyFor,
        QuestionRewrite,
        questionSeat,
        writeAnswer,
      },
    }
  },
})
