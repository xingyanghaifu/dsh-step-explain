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
    /** Host route that turns one call into one short paragraph. */
    const DETAIL_ROUTE = 'api/step-explain.detail'
    /** Host route that rewrites one rough instruction. */
    const REWRITE_ROUTE = 'api/step-explain.rewrite'
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
    /** Saved level; anything unreadable means the plain rule text. */
    let detailLevel = readDetail()
    const detailListeners = new Set()

    /** Read the stored level; storage can be disabled, so failure means `rule`. */
    function readDetail() {
      try {
        const raw = globalThis.localStorage?.getItem(DETAIL_KEY)
        return LEVELS.includes(raw) ? raw : 'rule'
      } catch {
        return 'rule'
      }
    }

    /** Store the level for every surface; a blocked write only loses the memory. */
    function setDetail(next) {
      detailLevel = LEVELS.includes(next) ? next : 'rule'
      try {
        globalThis.localStorage?.setItem(DETAIL_KEY, detailLevel)
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

    /** The next level in the cycle, so one button reaches all three. */
    function nextDetail(level) {
      return LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length]
    }

    /**
     * Saved study level. The default is the fullest one: the whole point of the
     * plugin is to say what a step is for and what follows, and a reader who
     * wants less can turn it down. An unreadable value falls back to that.
     */
    const STUDY_DEFAULT = 'plan'
    let studyLevel = readStudy()
    const studyListeners = new Set()

    /** Read the stored study level; a blocked read means the default. */
    function readStudy() {
      try {
        const raw = globalThis.localStorage?.getItem(STUDY_KEY)
        return STUDY_LEVELS.includes(raw) ? raw : STUDY_DEFAULT
      } catch {
        return STUDY_DEFAULT
      }
    }

    /** Store the study level for every surface; a blocked write only loses it. */
    function setStudy(next) {
      studyLevel = STUDY_LEVELS.includes(next) ? next : STUDY_DEFAULT
      try {
        globalThis.localStorage?.setItem(STUDY_KEY, studyLevel)
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

    /** Which of `now`/`why`/`plan` a level includes, in reading order. */
    function studyParts(level) {
      const upto = STUDY_LEVELS.indexOf(level)
      return STUDY_LEVELS.slice(0, upto === -1 ? 1 : upto + 1)
    }

    /**
     * Request body for the Host: the call and the answer language. The model is
     * not sent — the Host reads the saved choice from the profile itself.
     */
    function detailPayload(call, lang) {
      return { name: call.name, argsRaw: call.argsRaw, lang }
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
     * One rewrite request. The previous version and the change request are
     * context for the model, never instructions to the Host: nothing here is
     * executed, and the answer only ever lands in the draft.
     */
    async function fetchRewrite({ text, tone, lang, previous, instruction }, signal) {
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
          }),
          signal,
        })
        if (!response.ok) return ''
        const body = await response.json()
        return typeof body?.text === 'string' ? body.text : ''
      } catch {
        return ''
      }
    }


    /** One explanation for this call, or `''` for every kind of failure. */
    async function fetchDetail(call, lang, signal) {
      try {
        const response = await fetch(DETAIL_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(detailPayload(call, lang)),
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
     * Model paragraph for one call: `undefined` while asking, `''` when the
     * Host could not answer, and the text once it does.
     */
    function useModelDetail(call, enabled, lang) {
      const [text, setText] = React.useState(undefined)
      const name = enabled ? call.name : ''
      const argsRaw = enabled ? call.argsRaw : ''
      React.useEffect(() => {
        setText(undefined)
        if (name === '') return undefined
        const controller = new AbortController()
        let live = true
        void fetchDetail({ name, argsRaw }, lang, controller.signal).then((detail) => {
          if (live) setText(detail)
        })
        return () => {
          live = false
          controller.abort()
        }
      }, [name, argsRaw, lang])
      return text
    }

    /**
     * Composer strip: rewrite the rough draft into a clear instruction.
     *
     * Three states share one panel: the offer (a one-line button while the
     * draft is empty), the result (the rewrite beside 采用 / 退回), and a small
     * input for "改得再短一点" style follow-ups. Nothing here sends the message:
     * 采用 writes the draft through `inputActions.setDraft`, 退回 puts the
     * original text back, and the reader still presses Enter.
     */
    /**
     * How much detail a rewrite should carry. Ordered shortest to fullest, and
     * the three must match the Host's `TONE` keys or a request is rejected.
     */
    const TONES = ['concise', 'balanced', 'detailed']

    function RewriteBar({ useInput, inputActions, t }) {
      const draft = useInput((input) => input.draft)
      const [tone, setTone] = React.useState('detailed')
      const [busy, setBusy] = React.useState(false)
      const [offer, setOffer] = React.useState('')
      const [result, setResult] = React.useState('')
      const [note, setNote] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [ask, setAsk] = React.useState('')
      const abort = React.useRef(undefined)

      // A new draft invalidates the offer: the button always describes this text.
      React.useEffect(() => () => abort.current?.abort(), [])

      /** Run one rewrite of `text`; `instruction` carries a follow-up change. */
      const run = (text, instruction) => {
        const source = text.trim()
        if (source === '') return
        abort.current?.abort()
        const controller = new AbortController()
        abort.current = controller
        setBusy(true)
        setNote('')
        void fetchRewrite(
          { text: source, tone, lang: langNow(), previous: instruction === undefined ? '' : result, instruction },
          controller.signal,
        ).then((next) => {
          if (controller.signal.aborted) return
          setBusy(false)
          if (next === '') {
            // A failed attempt clears the old answer: offering to accept a
            // rewrite the reader just asked to change would be a lie.
            setResult('')
            setNote(t('rewrite.failed'))
            return
          }
          setOffer(text)
          setResult(next)
          // Collapsed by default: the change field is opt-in, not the main path.
          setOpen(false)
        })
      }

      // Nothing to rewrite: keep the composer untouched.
      if (draft.trim() === '' && result === '') return null
      return h(
        'div',
        { className: 'dse-dock' },
        h(
          'div',
          { className: 'dse-card' },
          h(
            'div',
            { className: 'dse-row' },
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
            h(
              'button',
              {
                type: 'button',
                className: 'dse-toggle',
                disabled: busy || draft.trim() === '',
                onClick: () => run(draft),
              },
              busy ? t('rewrite.busy') : result === '' ? t('rewrite.go') : t('rewrite.again'),
            ),
          ),
          note !== '' && h('div', { className: 'dse-warn' }, note),
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
                      inputActions.setDraft(result)
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
                      // Put the words back exactly as they were before adopting.
                      if (offer !== '') inputActions.setDraft(offer)
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
                      run(offer === '' ? draft : offer, ask.trim())
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dse-btn',
                      disabled: busy || ask.trim() === '',
                      onClick: () => run(offer === '' ? draft : offer, ask.trim()),
                    },
                    t('rewrite.apply'),
                  ),
                ),
              h('div', { className: 'dse-foot' }, t('rewrite.footnote')),
            ),
        ),
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
.dse-stack{display:flex;flex-direction:column;gap:6px;min-width:0;font-family:var(--dsw-font-family,inherit);word-break:normal}
.dse-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));margin:0 auto}
.dse-card{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,748px) - 4 * var(--dsh-composer-dock-inset,8px));margin:0 auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:8px 12px}
.dse-row{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dse-dot{flex:none;width:6px;height:6px;border-radius:50%;align-self:center}
.dse-strong{flex:none;font-weight:500}
.dse-muted{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dse-target{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-secondary)}
.dse-line{margin-top:4px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dse-warn{margin-top:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.dse-foot{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dse-tones{display:flex;gap:4px;flex-wrap:wrap;min-width:0;margin-left:auto}
.dse-tones .dse-btn{padding:2px 8px;font-size:12px}
.dse-toggle{margin-left:auto;flex:none;border:0;background:none;padding:0;cursor:pointer;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary)}
.dse-toggle:hover{text-decoration:underline}
.dse-toggle:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.dse-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.dse-list>li{display:flex;gap:8px;min-width:0;font-size:13px;line-height:20px}
.dse-index{flex:none;min-width:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dse-body{min-width:0;flex:1}
.dse-code{display:block;margin-top:4px;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dse-setting{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dse-setting-text{min-width:0}
.dse-setting-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dse-setting-desc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dse-select{flex:none;max-width:min(360px,50%);box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:4px 8px;font:inherit;font-size:13px}
.dse-select:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dse-page{display:flex;flex-direction:column;max-width:760px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dse-page-head{margin-bottom:4px}
.dse-page-title{margin:0;font-size:18px;line-height:26px;font-weight:600}
.dse-page-lead{margin:6px 0 4px;color:var(--dsw-alias-label-secondary)}
.dse-page-section{margin-top:20px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-tertiary);text-transform:none}
.dse-page-about{margin-top:8px;color:var(--dsw-alias-label-secondary)}
.dse-page-about p{margin:0 0 6px}
.dse-page-cost{margin:8px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dse-levels{flex:none;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;min-width:0}
/* Three level buttons are wider than the right-hand column at narrow widths,
   so this row stacks instead of squeezing them out of reach. */
.dse-setting-levels{align-items:flex-start;flex-wrap:wrap;gap:12px}
.dse-setting-levels .dse-levels{justify-content:flex-start;flex-grow:1}
.dse-full{margin-top:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.dse-full-part+.dse-full-part{margin-top:8px}
.dse-full-title{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dse-full-body{margin-top:2px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dse-rewrite{margin-top:6px;max-height:220px;overflow:auto;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dse-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.dse-btn{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:3px 10px;font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dse-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dse-btn:disabled{opacity:.5;cursor:default}
.dse-btn:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dse-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
/* After .dse-btn on purpose: a same-specificity rule placed earlier would be
   overridden, and the picked level would look identical to the other two. */
.dse-btn.dse-btn-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-brand-primary);font-weight:500}
.dse-ask{display:flex;gap:8px;margin-top:8px}
.dse-input{min-width:0;flex:1;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:4px 8px;font:inherit;font-size:13px}
.dse-input:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px}
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
      return label === undefined
        ? h('span', { className: 'dse-dot', style, 'aria-hidden': true })
        : h('span', { className: 'dse-dot', style, role: 'img', 'aria-label': label })
    }

    /**
     * The explanation lines shared by every surface, at the reader's study
     * level: the action is always named, `why` adds what it is usually for, and
     * `plan` adds what commonly comes next. The effect and undo lines follow.
     *
     * When the model switch is on, one model-written line is appended per call.
     * It is additive: the rule text above is what the reader always gets, so a
     * failed or slow request only means that extra line does not appear.
     */
    function Detail({ info, t }) {
      const level = useStudyLevel()
      const byModel = useExplainByModel()
      const parts = studyParts(level)
      const model = useModelDetail({ name: info.tool, argsRaw: info.argsRaw }, byModel && info.tool !== '', langNow())
      return h(
        'div',
        { className: 'dse-body' },
        h('div', { className: 'dse-line' }, t('step.line', { now: info.now })),
        parts.includes('why') && h('div', { className: 'dse-line' }, t('why.line', { why: info.why })),
        parts.includes('plan') && h('div', { className: 'dse-line' }, t('next.line', { next: info.next })),
        h('div', { className: 'dse-line' }, t('effect.line', { effect: info.effect })),
        h('div', { className: 'dse-line' }, t('undo.line', { undo: info.undo })),
        // The model line is labelled, so it is never mistaken for rule text.
        byModel && model !== '' && h('div', { className: model === undefined ? 'dse-muted' : 'dse-line' }, model ?? t('detail.waiting')),
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
      const picker = useModelPicker()
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
                  className: each === level ? 'dse-btn dse-btn-on' : 'dse-btn',
                  'aria-pressed': each === level,
                  // The row title already says what these pick, so the button
                  // carries only the level name.
                  onClick: () => setDetail(each),
                },
                t(`level.${each}`),
              ),
            ),
          ),
          'dse-setting-levels',
        ),

        row(
          t('page.study.title'),
          t(`page.study.body.${study}`),
          h(
            'div',
            { className: 'dse-levels', role: 'group', 'aria-label': t('page.study.title') },
            STUDY_LEVELS.map((each) =>
              h(
                'button',
                {
                  key: each,
                  type: 'button',
                  className: each === study ? 'dse-btn dse-btn-on' : 'dse-btn',
                  'aria-pressed': each === study,
                  onClick: () => setStudy(each),
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
      const study = useStudyLevel()
      const call = callOf(root)
      // Hooks run before the early return so the order never changes.
      const model = useModelDetail(call, level === 'model' && root !== undefined, langNow())
      if (root === undefined) return null
      const info = explain(call.name, call.argsRaw, t)
      // One value for both the label and the click, so they can never disagree.
      const next = nextDetail(level)
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
          h(
            'button',
            {
              type: 'button',
              className: 'dse-toggle',
              // Names the current level and where the click leads, so a
              // screen-reader user is not offered a destination-less "change".
              'aria-label': t('detail.levelAria', {
                level: t(`detail.${level}`),
                next: t(`detail.${next}`),
              }),
              onClick: () => setDetail(next),
            },
            t(`detail.${level}`),
          ),
        ),
        // The approval dialog is where a command is decided, so it carries the
        // study lines too — same level as the rest of the plugin, never a guess
        // at this model's motive.
        h('div', { className: 'dse-line' }, t('step.line', { now: info.now })),
        studyParts(study).includes('why') && h('div', { className: 'dse-line' }, t('why.line', { why: info.why })),
        studyParts(study).includes('plan') && h('div', { className: 'dse-line' }, t('next.line', { next: info.next })),
        command !== '' && h('code', { className: 'dse-code' }, command),
        info.danger && h('div', { className: 'dse-warn' }, t('approval.danger')),
        // `full` spells out the dialog itself, on top of the rule text above.
        level === 'full' && h(FullExplanation, { t, info }),
        h('div', { className: 'dse-line' }, t('approval.allow', { effect: t(`ok.${info.cat}`) })),
        h('div', { className: 'dse-line' }, t('approval.deny', { effect: t(`no.${info.cat}`) })),
        // A failed model call adds nothing: the rule text above already explained it.
        level === 'model' && model !== '' && h('div', { className: model === undefined ? 'dse-muted' : 'dse-line' }, model ?? t('detail.waiting')),
        // Only claim a model wrote something when one actually did.
        h('div', { className: 'dse-foot' }, model ? t('approval.footnoteModel') : t('approval.footnote')),
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
      'approval.footnoteModel': '以上说明由模型生成，可能有误；它同样不会替你选择。',
      'level.rule': '基础',
      'level.model': '模型补充',
      'level.full': '完整说明',
      'detail.rule': '详细程度：基础',
      'detail.model': '详细程度：模型补充',
      'detail.full': '详细程度：完整说明',
      'detail.levelAria': '当前{level}，点一下切到{next}',
      'detail.waiting': '正在让模型补充这一档的说明…',
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
      'page.study.title': '行为学习等级',
      'page.study.body.now': '只说明当前这一步在做什么。',
      'page.study.body.why': '在「做什么」之外，再说明这类操作通常是为了什么。',
      'page.study.body.plan': '再加上下一步可能做什么，方便你跟着理解它的节奏。',
      'study.now': '做什么',
      'study.why': '为什么',
      'study.plan': '下一步',
      'page.level.title': '审批框的说明档位',
      'page.level.body': '基础档只讲规则，不联网；模型补充档再多一段模型写的说明；完整说明档把审批框本身拆成五段讲清楚。只改说明文字，不改审批流程。',
      'page.section.model': '模型',
      'page.modelExplain.title': '让当前模型解释每一步',
      'page.modelExplain.body': '开启后，聊天里每一步的展开说明、每轮汇总和审批框都会多一行由当前模型写的话。关闭时全部由本机规则生成，不联网。',
      'page.modelExplain.on': '开启',
      'page.modelExplain.off': '关闭',
      'page.modelExplain.cost': '⚠ 会增加 token 消耗：开启后，每个工具调用都会单独发一次请求（工具名 + 参数原文 + 一句回答，上限 200 token），一轮里有 10 步就是 10 次。这些消耗计入你当前的模型额度，和聊天本身分开计算。看不清收益时建议先关着，只在审批框里用「模型补充」档。',
      'page.section.about': '关于',
      'page.about.privacy': '只有「模型补充」档会把工具名和参数原文发出去；基础档和完整说明档完全在本机生成。',
      'page.about.boundary': '这个插件只做解释：它不渲染允许/拒绝按钮，不拦截 Enter / Esc，也不会替你回答审批。',
      'settings.title': '步骤说明的详细版由哪个模型写',
      'settings.description': '保存到这台机器的配置里，重新进入设置页仍然生效。',
      'settings.followChat': '跟随聊天模型（默认）',
      'settings.saveFailed': '没保存成功，仍然沿用上一次的设置，请稍后再试。',
      'settings.unavailable': '读不到已保存的设置，暂时只能跟随聊天模型。',
      'rewrite.title': '把这句话写清楚',
      'rewrite.go': '帮我扩写',
      'rewrite.again': '重新扩写',
      'rewrite.busy': '正在改写…',
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
      'rewrite.failed': '这次没改成功，你的原文没有动，可以再试一次。',
      'rewrite.footnote': '只是帮你把话说清楚：采用后才写进输入框，发送仍然由你按。',
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
      'approval.footnoteModel': 'This explanation was written by a model and can be wrong; it still never answers for you.',
      'level.rule': 'Basic',
      'level.model': 'Model notes',
      'level.full': 'Full',
      'detail.rule': 'Detail: basic',
      'detail.model': 'Detail: model notes',
      'detail.full': 'Detail: full',
      'detail.levelAria': 'Current level: {level}. Click for {next}.',
      'detail.waiting': 'Asking the model for this level’s note…',
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
      'page.study.title': 'How much it teaches',
      'page.study.body.now': 'Names what the current step is doing.',
      'page.study.body.why': 'Adds what this kind of step is usually for.',
      'page.study.body.plan': 'Also adds what commonly comes next, so you can follow its rhythm.',
      'study.now': 'What',
      'study.why': 'Why',
      'study.plan': 'Next',
      'page.level.title': 'Detail level of the approval box',
      'page.level.body': 'Basic is rule text only and never goes online. Model notes adds one model-written paragraph. Full spells out the approval box itself in five parts. All three change the words only, never the approval flow.',
      'page.section.model': 'Model',
      'page.modelExplain.title': 'Let the current model explain each step',
      'page.modelExplain.body': 'When on, every expanded step, every turn summary and the approval dialog gain one line written by the current model. When off, everything is generated locally with no network call.',
      'page.modelExplain.on': 'On',
      'page.modelExplain.off': 'Off',
      'page.modelExplain.cost': '⚠ This costs tokens: with it on, every tool call sends its own request (tool name + raw arguments + one short answer, capped at 200 tokens), so a ten-step turn is ten requests. That spend counts against your current model quota and is billed separately from the chat itself. Leave it off unless the extra line earns its cost, or use the Model notes level in the approval dialog instead.',
      'page.section.about': 'About',
      'page.about.privacy': 'Only the model-notes level sends the tool name and its arguments off this machine; basic and full are generated locally.',
      'page.about.boundary': 'This plugin only explains: it renders no allow or reject control, does not intercept Enter or Escape, and never answers an approval for you.',
      'settings.title': 'Model that writes the detailed step explanation',
      'settings.description': 'Saved to this machine, so it survives leaving and reopening Settings.',
      'settings.followChat': 'Follow the chat model (default)',
      'settings.saveFailed': 'That did not save, so the previous choice is still in effect. Try again.',
      'settings.unavailable': 'The saved setting could not be read, so the chat model is used for now.',
      'rewrite.title': 'Say it clearly',
      'rewrite.go': 'Rewrite',
      'rewrite.again': 'Rewrite again',
      'rewrite.busy': 'Rewriting…',
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
      'rewrite.failed': 'That rewrite did not come back. Your text is untouched, so you can try again.',
      'rewrite.footnote': 'This only words it better: nothing reaches the draft until you accept, and you still send it.',
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
        ctx.slots.register({ name: 'conversation.input.dock', id: 'step-explain', order: 30, locale: NS }, LiveStep),
      )
      // Same dock, its own cell: the rewrite offer sits beside the live step.
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'step-explain-rewrite', order: 40, locale: NS }, RewriteBar),
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
        nextDetail,
        LEVELS,
        readStudy,
        setStudy,
        studyParts,
        STUDY_LEVELS,
        readExplain,
        setExplain,
        Detail,
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
      },
    }
  },
})
