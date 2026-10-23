# Step Explain · dsh-step-explain

Explains every step the model takes in plain language anyone can follow.

> For people new to AI coding tools: stop guessing "what did it just do", "is this command dangerous", or "what happens if I click Allow".

English | [简体中文](README.zh-CN.md)

---

## The problem it solves

| Situation | Without this plugin | With this plugin |
| --- | --- | --- |
| The model is reading a file | Just a line `read README.md` | "Reading file `README.md`", expandable to see the impact and whether it can be undone |
| A turn finishes | A dozen tool calls piled up in the chat | One summary line "7 steps · read 3 · changed 2 · ran 2 commands", expandable step by step |
| An approval dialog appears | Only the raw command, with no clue what it does | Says what the step does, its risk level, and what Allow / Reject each lead to |
| Your own wording is too vague | Delete and retype, or send it and hope | "Say it clearly" rewrites it into a precise instruction you can use, revert, or send back for changes |

## Three surfaces

1. **Above the composer** — the step the model is running right now, in one line, with a "What is this" button that expands the details.
2. **At the end of each turn** — a summary of every step in that turn, expandable step by step.
3. **In the approval dialog** — takes over the raw-command line and replaces it with a full explanation (risk plus the consequence of each choice).

There are two settings entry points: **Settings → Step Explain** (this plugin's own page, with the fullest explanation, sitting beside pages from other plugins), and a row inside **Settings → General** (a shortcut). Both edit the same setting, so they never disagree.

## Settings → Step Explain (this plugin's page)

Click **Step Explain** in the settings nav to open it. The page has three blocks:

- **Explanation detail** — the three approval-dialog levels side by side (Basic / Model notes / Full). One click picks one, and the current level is highlighted. The buttons carry only the level name; the "detail" prefix comes from the row title, so all three still fit in a narrow panel (they wrap when space runs out instead of being pushed out of view). A paragraph below explains what each level adds.
- **Model** — the "which model writes the detailed explanation" dropdown. Choosing saves immediately.
- **About** — one sentence on which level goes online, and that this plugin only explains; it never answers an approval for you.

The page follows the Harness settings shell's own idiom (title, sections, rows). It adds no dependency and needs no new Host route; it gathers the General row and the approval-dialog level buttons onto one page, reading the same state.

## Rewriting a rough sentence into a clear instruction

There is also a "Say it clearly" bar above the composer. When you have written something you know is vague (say "fix that bug"), click **Rewrite** and the model turns it into an instruction you can act on: goal, scope, expected result, how to verify. Then you can:

- **Use it** — writes this version back into the composer. The text is yours, and you still press Enter.
- **Revert** — puts your original sentence back, unchanged, character for character.
- **Ask for a change** — opens a small field where you write "shorter" or "add how to verify"; press Enter or click **Rewrite it** and the model reworks the whole thing with the previous version as reference.

The top right has **three length levels** side by side: **Short / Medium / Full**. Click the one you want; the current level is highlighted, and there is no cycling back and forth.

| Level | Roughly what comes back |
| --- | --- |
| **Short** | Two or three sentences at most; every word you can cut is cut, with no repeating of the original. |
| **Medium** | One sentence for the goal, plus only the scope and expected result that matter, without turning it into a list. |
| **Full** | The goal, scope, steps and how to verify as separate points, one sentence each. (Default) |

**It never sends for you**: unless you click **Use it**, nothing in the composer changes, and sending is always your Enter. The composer stays usable while a rewrite runs.

### Reading the conversation (off by default)

A rewrite can read the current conversation, so a sentence like "fix that bug" is rewritten into something specific instead of staying vague about what "that" means. The bar shows a **Read chat: on/off** button, and the same switch sits in **Settings → Step Explain**.

| State | What a rewrite sends |
| --- | --- |
| **Off** (default) | Only the sentence in your composer, plus any change you asked for. Nothing about the conversation leaves this machine. |
| **On** | The same, plus the last few messages between you and the assistant, up to 4000 characters. |

What is read, when it is on: your own visible messages and the assistant's visible replies, newest first until the cap. Tool arguments, tool results, reasoning and anything hidden are never included — a rewrite needs to know what you meant, not what the tools were doing. The transcript is labelled as background in the request, so the model treats it as context for the sentence and not as a second instruction to rewrite.

The switch is read at send time, so flipping it applies to the very next rewrite with no reload. Its state is remembered per browser.

> A request is sent only when you click **Rewrite**. What it carries is the text in your composer (plus any change you asked for, plus the conversation when the switch is on). No click, no request.

> The third surface only **explains**: it renders no Allow / Reject control, never intercepts Enter or Escape, and never decides for you.
> All it adds is one level button in the top right (see below), and that button submits no answer.
> If this plugin's cell fails, the interface falls back to the system's own rendering, and approval is unaffected.

## Every level at a glance (nothing is still a two-state toggle)

| Where | Control | Levels |
| --- | --- | --- |
| Top right of the approval dialog | Cycle button (one click, one level forward) | Basic → Model notes → Full |
| Settings → Step Explain, and the approval dialog | Three buttons side by side | Basic / Model notes / Full |
| "Say it clearly" above the composer | Three buttons side by side | Short / Medium / Full |

All three are three levels or more; none is still a "brief / detailed" two-state toggle. The approval level is shared between the settings page and the dialog itself, so changing one changes the other.

## Approval-dialog levels (three, one click each)

The button in the top right cycles the level. It always shows the level you are on, and the choice survives a refresh:

| Level | What you see |
| --- | --- |
| **Basic** (default) | The rule-based explanation: what this step does, its risk level, the command as written, and what Allow / Reject each lead to. |
| **Model notes** | Everything in Basic, plus one or two sentences written by a model to cover what the rules cannot. |
| **Full** | Everything in Basic, plus five fixed sections: what this box is for, why it appeared, what each line shows, the choices you have, and things to watch out for. |

The three levels change **the explanation text only**. The approval flow itself is untouched: Allow and Reject are still decided by the system dialog's own buttons, and this plugin's cell never offers an answer.

The **Full** level is for "first time seeing this, I want to understand before deciding". It describes the dialog itself rather than a model-written sentence, so there is no made-up-model-content risk and no network call.

## What the explanation contains

Each step names what is happening, then adds how much of the *behaviour* you asked to learn. That is the **study level**, a setting of its own:

| Study level | What the step shows |
| --- | --- |
| **What** | What this step is doing, in plain words. |
| **Why** | The same, plus what this kind of step is usually for. |
| **Next** (default) | The same, plus what commonly comes next, so you can follow its rhythm. |

Under those, every step always gives:

- **Impact** — for example "The command really runs: it may change files, install software or go online."
- **Whether it can be undone** — for example "It depends on the command; read what it does before deciding."

Plus a **risk level** (Low / Caution / Touches data) and **what it is operating on** (a file name, a command, a URL, a search term).

The "why" and "next" lines describe **the kind of step**, never this model's private motive — the wording says "usually" and "most likely" on purpose. A dangerous command gets its own pair of lines instead of the calm ones.

The approval dialog additionally gives:

```
Run a PowerShell command                              Caution
Runs a command on this machine, with no limit on what it can do.
Why this step: Usually to verify, build or run, confirming the result from real output instead of assuming it.
Likely next: Most likely it reads the output and decides: carry on if it passes, come back and fix it if not.
  npm test
Allow: the command really runs, and may change files on disk.
Reject: the command does not run, and nothing happens.
This is an explanation only; it does not choose for you.
```

The warning line is missing above because `npm test` does not look destructive. Recursive delete, force push, `DROP TABLE`, piped-into-shell and the like add a red line under the command.

## The study level (how much it teaches you)

**Settings → Step Explain → How much it teaches** has three buttons: **What / Why / Next**. They stack — Next includes Why, and Why includes What — so picking a higher level never loses the line you already had.

- **What** names the action only. The quietest of the three.
- **Why** adds what this kind of operation is normally for: reading to see before changing, writing to make a worked-out change take effect, running to confirm from real output, and so on.
- **Next** adds what commonly follows: read → more reading or a change, write → a test or command, command → read the output and decide, question → wait for your answer.

Everything on all three levels is local rule text. **No level sends anything anywhere**; the study level is independent of the model switch and the Model notes level, which are the two things that can go online.

## Having the current model write each step's explanation (off by default)

**Settings → Step Explain → Have the current model write each step's explanation** replaces the local rule text with text written by the current model, at the study level you picked. It is off by default.

- **Off** — every explanation is generated on this machine. No request, no tokens, no network.
- **On** — every tool call sends its own request to the current model (or the one picked above) and the answer becomes the explanation for that step.

The impact and reversible lines always stay local, because they are the facts the reader decides on; a model that times out or is unconfigured can never leave you without them. While an answer is in flight the rule text is shown, so the panel is never blank.

The switch covers every surface, the approval dialog included. That dialog also keeps its own **Model notes** level, which asks for a model paragraph even when the switch is off.

**This costs tokens.** Each step is a separate request: the tool name, its raw arguments, and a short answer (capped at 200 tokens for the shortest study level, 320 for the fuller ones). A ten-step turn is ten requests. That spend comes out of your current model quota and is billed separately from the chat itself. The settings page states this in a warning line under the switch.

Two things keep the bill down without changing what you see:

- **Answers are cached** per call and level, so collapsing and reopening a summary, or switching a level away and back, costs nothing the second time.
- **Requests run one at a time.** A ten-step summary would otherwise fire ten concurrent calls at the same provider, which invites a rate limit that fails all of them. Serial costs latency, never extra tokens.

A model-written explanation carries a footer saying so, so it is never mistaken for the rule text, and it is clipped at 240 characters so a chatty model cannot push the impact and undo lines off screen.

## The Model notes level (optional, uses a model)

Set the level to **Model notes** and the approval dialog gains one or two sentences written by a model, with a line saying that a model wrote them and they may be wrong. **The default is Basic, which makes no network call.**

- **A request is made only on the Model notes level**: Basic and Full send nothing; every word on them comes from local rules and fixed text.
- **What leaves the machine**: the tool name, this step's raw arguments (command, file path, and so on), and the reply language. No conversation history, no transcript, no machine details. The Host decides which model to use from the saved setting; the browser never sends a model name.
- **Which model**: by default the same one the current chat uses. To give it its own model, pick one in the settings page (next section).
- **If it fails**: no configured model, a timeout, or an error simply means that paragraph does not appear. The rule-based explanation above it stays, and approval is unaffected.
- **The level is remembered per browser**: each browser keeps its own choice, and it survives a refresh.

> Switching to Model notes means agreeing that those argument words leave this machine for a model service. If that matters to you, stay on Basic or Full; neither goes online.

### Choosing the model for the detailed explanation (saved from the settings page)

Open **Settings → Step Explain** (or the row inside **Settings → General**) and find "which model writes the detailed explanation". Pick one from the dropdown; the default is "Follow the chat model". The list is exactly the models currently available on this machine.

**Choosing saves**: the choice is written into this machine's profile configuration (the same write path the official model settings page uses), not just into browser storage. It survives leaving the page, a refresh, and restarting Harness, and it applies across browsers because it is stored per machine. To undo it, pick "Follow the chat model" again.

When it cannot be written (a read-only config, for example), the row says plainly that the save did not succeed and the previous setting still applies — it never pretends to have saved.

### Choosing the model in the configuration file

To make one model the default for **everyone** who opens this machine, uncomment and fill in the block in `cordis.patch.yml`:

```yaml
- insert:
    - id: step-explain
      name: dsh-step-explain
      config:
        provider: deepseek
        model: deepseek-chat
```

A half-filled pair (only `provider`, say) counts as unset and falls back to the chat model. Restart or reload the plugin to apply it.

Precedence, highest first: **your choice in the settings page → `provider`/`model` in the config → the current chat model**.

You can also edit this entry's configuration in the plugin manager, with no file editing.

## Tools covered

Grouped into seven kinds by meaning. Unlisted tools fall back to a generic explanation, so a raw key is never shown:

| Kind | Examples | Risk |
| --- | --- | --- |
| Reading files | `read` `read_image` `skill` `cordis_inspect_*` | Low |
| Searching | `glob` `grep` | Low |
| Changing files | `write` `edit` `str_replace_editor` | Caution |
| Running commands | `pwsh` `bash` `terminal_open` `terminal_send` | Caution / Touches data |
| Going online | `web_search` `web_fetch` | Caution |
| Asking you | `ask_user_question` | Low |
| Adjusting session state | todos, plans, goals, scheduled reminders | Caution |

The risk level comes from **the kind of operation**, never from guessing the model's intent.

## Install

Already installed on this machine (`link:E:/dshwork/dsh-step-explain`, added to the profile's bundles). On another machine:

```bash
# Run this through plugin management inside Harness
plugin_manager install_bundle target="link:E:/dshwork/dsh-step-explain"
```

Refresh the page after installing. It has no required configuration and writes no files; a model is called only when you switch the detailed level on yourself.

## Disable

Edit `cordis.patch.yml`:

```yaml
- insert:
    - id: step-explain
      name: dsh-step-explain
      disabled: true
```

## Self-checks

```bash
node selftest.mjs      # interface and explanation layer
node hostselftest.mjs  # Host half (routes, validation, failure fallback)
```

Node only, no dependencies (the Host check uses a fake Context and makes no network call). Covered: category fallback, risk judgement, dangerous-command detection, truncated and malformed JSON arguments, running and finished tool nodes, hidden-node filtering, zh/en dictionary parity, every `t('...')` key in the source existing, the real rendered text of all three surfaces in four states (empty / running / finished / approval), the three approval levels actually differing (Basic neither goes online nor adds a paragraph, Model notes adds exactly one model paragraph, Full really gains five sections and is clearly longer, and all three render only the level button with no Allow / Reject control), the level cycle and old-value fallback (an old `on`/`off` or garbage value returns to Basic), the settings row's read and write (reading back the saved choice, showing a change only after a successful save, and distinct notices for a failed save and an unreadable one), the settings page's content and three level buttons (all three listed, the current one marked `aria-pressed`, a pick writing to the same storage key, and the page stating which level goes online and what the read-only boundary is), **actually clicking every level on the page in a live hook runtime** (the store updates, the re-render follows the pick, and it can go back — covering the "visible but does not respond" regression), the cascade order of the selected-state style (the selected rule must come after the base rule and after `:hover`, or equal specificity lets the base rule win and all three buttons look identical — which was exactly the "clicking does nothing" cause), and which cells `apply` actually registers (four chat surfaces, the settings page and the General row; the page's `id`/`locale` nav label is right, the two dock cells use distinct `id`s, and no cell registers an approval answer), the rewrite bar's whole flow (no draft / use / revert / ask for a change / failure, including Enter never sending the message), the three rewrite lengths (all three listed, the default on Full, the highlight moving on click, and the three never collapsing into two), the Host producing a different system prompt per level (asserting the three prompts differ from one another, so no level can be silently folded into another), **the settings row and the settings page sharing one model dropdown** (both render the same `select` props and options, and the source builds `dse-select` only once, so two implementations cannot drift apart); plus the Host's request validation (types, required fields, length caps, a model pair needing both provider and model, an unknown length refused), only `text-delta` reaching the body, model precedence (saved settings choice → config → chat default), **profile reads being cached and immediately invalidated by a save** (the explain, rewrite and settings routes share one read rather than one each — the cache is keyed by Loader entry, not by context object, because each route holds a different derived context), model output sanitizing (code fences and prefixes), model errors / no route / no default model all answering 200 with an empty result, and the model setting's read, save, clear, and rejection of invalid input (400/415), with 409 rather than a fake success when the configuration is read-only.

## Known limits

- Taking over the approval dialog relies on "a single slot renders its lowest-priority entry". If another plugin claims the same slot at an even lower priority, which one renders depends on load order; that is a general limit of the current plugin ecosystem (marked `shortcut:` in the code). Uninstalling the plugin or crashing it brings the system's own command line straight back.
- The risk level is a heuristic: tool kind plus dangerous-command patterns, with no attempt to guess the model's intent. It may label a safe command as "Touches data".
- The detailed model paragraph is written by a model and may be wrong. It is capped at 600 characters, feeds no decision, and is only one extra line of reference.
- Rewrites are model-written too and may add things you never said (it is told not to invent, but that is not a guarantee); skim before you use one. Rewritten text is capped at 4000 characters.
- "Ask for a change" reworks the latest version and keeps no earlier history: after several rounds only the most recent version is used as reference. To start over, click **Rewrite again**.
- The model choice in the settings page lives in this machine's profile configuration, not in browser storage: it works across browsers, and when the configuration file is read-only the choice cannot be saved and the row says so explicitly. To make one model the default for everyone, use `config` in the configuration file instead.
- Profile reads are cached within the process and invalidated immediately by a save, but **editing `cordis.patch.yml` by hand is not noticed right away**; it takes a plugin reload (marked `shortcut:` in the code).
- No in-browser visual walkthrough has been done; structure and wording are covered by the self-checks, and the controls, widths and colours reuse the same tokens and idiom as the system plugins.

## Implementation notes

- **Mostly client-side**: the Client half owns every explanation, the three surfaces, the rewrite bar and the settings page (both the page and the General row); the Host half provides three small routes (detailed explanation, rewrite, and reading/writing the model setting).
- **Read-only**: it registers six render cells (three chat surfaces, the settings page, the General row, the rewrite bar). It subscribes to no events, changes no session, sends no message and touches no tool permission. The only write is putting text back into the composer when you click **Use it** / **Revert**.
- **Rewriting only touches the composer**: it goes through the composer's own `inputActions.setDraft`, equivalent to pasting by hand. It submits nothing, queues nothing and triggers no model. The result is treated as text, never parsed as an instruction.
- **The approval cell replaces only the raw-command line**: a single slot renders its lowest-priority entry, and the plugin covers the system's line with a fuller explanation, so it must show the command itself again. When this cell crashes, the slot automatically hands rendering back to the system.
- **Every route goes through Connection's authorization fence**: `ctx.connection.fetch.register` registers `/api/step-explain.detail` and `/api/step-explain.rewrite`, reachable only from pages with an owner subject. It opens no HTTP port of its own and bypasses no authentication.
- **The settings row adds no dependency**: the model choice is read and written through the plugin's own `api/step-explain.model` route, and the Host writes it into the profile patch using Harness's built-in `configEditor`, the same write path as the official model settings page. So it needs no schemastery and no restart. With a read-only configuration the row says the save did not succeed and leaves the choice alone. Without `remote.session` the dropdown offers only "Follow the chat model", and nothing else is affected.
- **Code in two files**: `client.js` ≈ 1300 lines (dictionaries included), `index.js` ≈ 359 lines.

## Files

```
dsh-step-explain/
├─ package.json        plugin manifest (dsh.bundle + dsh.client)
├─ cordis.patch.yml    inserts itself into the composition
├─ index.js            Host half (model forwarding route for the detailed version)
├─ client.js           all surfaces, explanation logic and settings (page + row)
├─ locale/zh.json      name and blurb shown in the market and settings
├─ locale/en.json
├─ icon.svg
├─ selftest.mjs        interface and explanation self-checks
└─ hostselftest.mjs    Host half self-checks
```
