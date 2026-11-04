# What Asuna needs from DSH

This is the interface control document between DSH and Asuna, a plugin that runs a character on a DSH Web Host. It
states what Asuna needs from DSH as requirements, not code. DSH's code interface may change; a requirement stays the
same until both sides agree to change it.

The specs in this folder test the requirements against DSH alone: a DSH tag plus the fork's `asuna/*` patches, with
no Asuna checkout and no live profile.

```
corepack pnpm exec vitest run scripts/asuna-icd
```

## How to read a requirement

Each requirement has an ID, one statement of the behaviour, and what breaks for the character without it. It also
has a kind and a binding:

| Kind | Meaning |
|---|---|
| **P** | DSH meets it through its public API. |
| **I** | Asuna meets it today through a DSH internal: a private field, a file layout, the order hooks run in, or DSH's own text. It is debt. Either Asuna stops relying on it, or DSH offers it properly. Until then it is tested as it is, so a break is seen. |
| **F** | It exists only through one of the fork's `asuna/*` patches. |

**Binding** names the DSH API or file that meets the requirement today. It is a pointer for the specs, not part of
the requirement.

Each spec names its requirement ID in its title (`it('SES-3 …')`). [Coverage](#coverage) lists which spec checks
each requirement, how (behaviour or source check), and the requirements with no spec yet.

## How this changes

- **A binding change** is when DSH renames or reshapes an API but still meets the requirement. The DSH upgrade agent
  updates the spec and the binding line, and lists each one in its version report. That list is what Asuna picks
  up with its own code changes.
- **A requirement change** (new, changed or dropped) is agreed between Asuna's lead agent and the DSH upgrade
  agent. The owner decides when they disagree.
- **A failing spec with no binding that meets it** blocks the version. It is reported to Asuna before any switch.

Contents: [Install](#ins-install-and-composition) · [Framework](#fw-plugin-framework) · [Sessions](#ses-sessions)
· [Turns](#trn-inbox-and-turns) · [Prompt and tools](#tl-prompt-and-tools) · [Models](#llm-models)
· [Compaction](#cmp-compaction) · [Schedule](#sch-schedule) · [Services](#svc-host-services) · [Web UI](#ui-web-ui)
· [Peer](#peer-another-dsh-web-host) · [Coverage](#coverage)

## INS. Install and composition

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| INS-1 | Installing a plugin tarball into a named profile puts the package in unchanged, file for file. It runs none of the package's lifecycle scripts, merges the package's bundle patch into the profile's composition, and reports success only when all of that happened. | Her packages, and the updates she publishes herself, never activate. | P | `dsh plugin --profile <p> add <tgz>…`; `package.json` `dsh.bundle.patch`; the installer runs `pnpm` from `PATH` |
| INS-2 | Every `@deepseek-ai/*` package an installed plugin peers on resolves to the Host's own copy: one instance of each service and class. | Services not found; `instanceof` checks fail. | P | peers resolved from scope `installation` |
| INS-3 | A plugin whose `@deepseek-ai/*` peers all name the Host's version passes the compatibility check. | The plugin is refused at load. | P | `evaluatePluginCompatibility` (app-boot), which compares every peer range with the runtime's own version |
| INS-4 | A bundle patch can insert rows in a given order, disable a shipped row by its id, and group rows so that each group gets its own isolated services. Config values can name paths inside DSH home. A profile can disable DSH's own session persistence and LLM titling, choose the web search and fetch providers, the default agent preset and the default model. | Two persistence services; presets share one compaction engine; an LLM titles her conversations; DSH's own search is used. | P | `cordis.patch.yml` `insert`, `disabled`, `cordis:group` with `isolate`, `!!js dshHomePath(...)`; shipped rows `session-persistence-jsonl`, `web` (`searchProvider`, `fetchProvider`), `agent-preset-registry` (`default`), `agent-default-model`, `session-title-llm` |
| INS-5 | The native Settings page saves to the profile's editable composition layer, a YAML 1.2 file with rows keyed by id, so an installer can merge its own rows by id without losing the owner's settings. | The owner's settings are lost or rewritten at every install. | I | `<home>/profiles/<p>/cordis.patch.yml` |
| INS-6 | The CLI can create a profile from the Web template without starting a Host. It can run a foreground Web Host for a profile on a chosen address and port, logging to stdout and stderr and exiting non-zero on a crash. An environment variable chooses DSH home; another turns telemetry off. | Fresh installs fail; the supervisor cannot keep her up. | I | `@deepseek-ai/dsh/lib/bin.js`; `--profile <p> --from-default-profile web --help`; `--profile <p> --no-open --host <h> --port <n>`; `DSH_HOME`, `DSH_TELEMETRY_DISABLED` |
| INS-8 | A fork build of a DSH package, published with a prerelease suffix of the Host's version (`<version>-asuna.N`), installs in place of the released package. | The fork's patches never reach the profile. | I | holds because the compatibility check never compares the installed package's own version (INS-3), together with Asuna's own installer |
| INS-7 | While the Host is down, DSH home can be tidied safely. Each session is one folder, and moving it out removes the session. The projection cache is one rebuildable file per session that may be deleted. An empty writer-lock file names no live writer and may be deleted. | Stores grow without end; a start fails on too many open files; every start waits on a dead lock. | I | `<home>/sessions/<project>/<id>/`; `<home>/storages/session_projcache/sessions/<id>.json`; `<home>/*.lock` |

## FW. Plugin framework

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| FW-1 | A plugin can provide its own services, wait for required services before it applies, and wire optional services when they appear. The wiring is disposed when they go, and the cleanup a plugin registers then runs. A plugin can also probe whether a service exists. | The core never applies; plans, commands, settings or search are not wired; a reload leaves the old wiring running. | P | `ctx.provide`, `inject`, `ctx.inject([...], cb)` for `schedule`, `commands`, `settings`, `web`; cleanup is `scope.effect(() => dispose)` (`scope.on('dispose')` does not run on disposal); `ctx.get` throws when absent |
| FW-2 | Plugin config fields marked volatile apply without reloading the plugin. The settings service changes a namespace under a revision fence and can be told not to reload automatically. Secrets in config can be redacted for display. | A saved setting reloads the whole plugin, or two saves overwrite each other. | P | schemastery `.volatile()`; `settings.configure({auto:false})`, `describe`, `mutate(ns, ops, revision)`; `redactSecrets` |
| FW-3 | A plugin can receive every plugin's log messages (name, level, arguments, time) to write its own log. | Her Host log loses its lines. | I | `ctx.logger.exporter({export})` |
| FW-4 | A plugin can learn DSH home and the profile name. A preset scope can reach the attachment service and its own isolated skill service. | No data root; her pictures are not read; the action side has no skill tool. | I | `reflect.get('profileContext')`, `reflect.get('attachments')`; `isolate('skills')` with `dsh-skill`, `dsh-skill-filesystem`, `dsh-tool-skill` |

## SES. Sessions

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| SES-1 | A plugin can open an agent on a session id it chooses, with a chosen preset, parent session, metadata and model options (provider, model, reasoning effort, max tokens), and a setup step that runs before the first step. It can resume that agent later with new options, find a live agent by session id, and dispose it, which releases write ownership. | No conversation opens; applied settings never reach open conversations. | P | `agents.create`, `agents.resume`, `agents.get`, `handle.dispose()` |
| SES-2 | A plugin can register agent presets, shown by the name it gives. A standing preset is mounted once and receives every member agent's events, keyed by session. A preset's own isolated service can be looked up for one agent. | Per-conversation state mixes; turn-end compaction and size checks go quiet. | I | `agentPresets.register`, `mount`, `serviceFor(agent, 'compaction')` |
| SES-3 | A session has one writer at a time, and a second open for write fails with a recognisable error. With no agent loaded, a plugin can stat, list, read, create and append to a session log, assigning sequence numbers itself, and flush it. The result loads normally in DSH. The first visible event of a log is the system message written at the agent's first step. | Lines written while her conversation is not loaded are lost, or the log becomes unloadable. | I | `sessionPersistence.stat/list/open/create`; handle `read/append/flush/close`; `SessionAlreadyOwnedError`; `sessions.prepare`, `sessions.flush` |
| SES-4 | After a cold write, a plugin can write the session's projection checkpoint and tell open browsers about a new or renamed session, so it appears in the sidebar without a reload. | The start times out on the checkpoint; new conversations appear only after a reload. | I | `sessionProjectionCache.coldSnapshot/cachedSnapshot/write`; `ctx.emit('api-session/added', summary)`; `sessionController.list/rename` |
| SES-5 | A plugin can append its own event types to a session, and replace a surface range in place. Its events persist and round-trip. They are marked ignorable, so DSH's readers and projections skip them, and old logs keep loading. A session format migration keeps them readable under a name the plugin can predict. | Logs become unreadable to plain DSH; her own records are lost, or silently renamed past her readers. | I | `session.append(type, data, {surfaceOp})`; `ignorable: true`, which `Session.append` cannot set, so a `SessionPersistence` wrapper sets it; the V3-to-V4 edge renames an unknown ignorable event to `plugin:<type>`; DSH's own API for such records is `appendPluginRecord`/`pluginRecordOf` (experimental) |
| SES-6 | Extra fields in a user message's `source` (kind, channel, receipt, sender, trigger and similar) persist in the log and are never sent to the model. | Receipts and who-said-what are lost, or leak into her prompt. | P | `createUserMessage({content, source})` |
| SES-7 | These session events keep their meaning and fields: turn and step start and end (step end is written even when the step fails), tool call and result with call ids, compaction start, end, summary and end-seed, the checkpoint message carrying its compaction id, an assistant message's content blocks, usage, interruption and redacted reasoning, the latest session title winning, model selection, the subagent descriptor and catalog records, and live text chunks. | Her stage view, turn-end compaction, pairing of lines with tool results, and the subagent list break. | I | `turn/*`, `step/*`, `tool/*`, `compaction/*`, `session/end-seed`, `assistant/message`, `session/title`, `model/selection`, `subagent/descriptor` v3, `subagent/catalog` v0, `assistant/live-chunk` |
| SES-8 | Workspaces: one per folder (creating it twice returns the same one), ordered, deletable. A session can be attached to a workspace, archived and unarchived. An archived session refuses activity; an active session cannot be archived. | Her navigation breaks; channel turns are blocked. | P | `workspaceRegistry.create/list/insertBefore/delete/archiveSession/unarchiveSession`, `attachSession` |
| SES-9 | For a loaded session, a plugin can read its context-pressure and context-breakdown projections. | The action meter is blank. | P | `sessionProjections.snapshot(session, ['contextPressure','contextBreakdown'])` |
| SES-11 | For a loaded session, a plugin can read its current agent preset, which follows a later preset pick. | The path-privacy lane check reads the wrong preset. | I | `sessionProjections.stateOf(session, 'agentPreset')`, another plugin's projection unit read through the registry |
| SES-10 | A plugin can build a fork seed from a session's events at DSH's default cut. | An errand's seed is wrong, or misses the prompt cache. | I | `buildForkSeed` (`dsh-session/fork`); Asuna copies the default cut |

## TRN. Inbox and turns

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| TRN-1 | An agent's inbox: a follow-up queues a turn and starts it when the agent is idle. An injected message is delivered at the next step and never wakes an idle agent. A steered message goes to the next step. The next-step and next-turn queues are readable, and a message can be removed, appended or spliced. A splice persists and is folded back in when the log loads. | Lines are dropped or doubled; her stages never run. | I | `agent.followup/inject/steer`; `inbox.nextStep/nextTurn/remove/append/splice`; `agent/inbox/spliced` |
| TRN-2 | An agent is running from the claim of a turn's input to the end of that turn, and idle otherwise. Maintenance (compaction) counts as idle. A plugin can wait for idle, and is told idle at every turn end. | A steered line fails her turn; threads flush at the wrong time. | P | `agent.status`, `agent.whenIdle()`, `agent/status` |
| TRN-3 | A plugin hears that a message was inserted after it is in the inbox, while the agent is running, in time to move it to the next turn before it is claimed. | A person's steered line arrives mid-stage and fails her turn. | I | `agent/inbox/inserted` |
| TRN-4 | Within a turn, the hooks run in this order: each message claimed; system prompt assembly, which may wait minutes and whose sections and tools are used as returned; pre-step, which can add messages or reject the step with no model request; the request, whose returned provider, model, effort and max tokens are used; the stream, whose finish reason is visible; step end; turn-stopping, which is awaited and runs only after a step that returned, where a steer continues the same turn; then idle. | Web lines never reach her worker; wrong system prompt; tools leak; repair rounds end her turn. | I | `agent/inbox/claimed`, `system-prompt/assemble`, `agent/pre-step`, `agent/request`, `agent/assistant-stream`, `agent/turn-stopping`, `agent/status` |
| TRN-5 | A failed request can be retried by a plugin, which also gets DSH's own retry decision. A failed turn carries its cause chain, including a context-window-exceeded code after the one overflow compaction failed. A turn can be cancelled while keeping the queued input. | Fallbacks between models fail; a full conversation is never carried to a new one; fenced tasks keep running. | P | `agent/request-error` `next()` and `{kind:'retry'}`; `agent/error`; `agent.cancel(reason, {keepInbox:true})` |
| TRN-6 | A plugin hears about every new and resumed agent, and the handler finishes before the agent's first step. | Her role and action tools are missing. | P | `agent/created` |

## TL. Prompt and tools

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| TL-1 | A preset scope can blank a global system prompt section by registering one under its name, add its own sections, suppress the runtime context, and shadow the working-directory context with an empty one that is not sent. The sections that must be blankable: harness identity, harness source, deliverable file references, Web surface, the web search tool, and the persona prefix. | DSH's developer and identity text, the Host's details, or a local path enter her prompt. | I | `systemPrompt.section`, `getSectionOrder`, `suppressRuntimeContext`, `context({name:'working-directory:current', required:true, text:''})` |
| TL-2 | A scope can empty its inherited tool set and register its own tools. A tool's output can render as images plus text. A plugin's guard can refuse a call with its own wording before argument validation. A tool can end the turn after its result. Tools take timeouts and a concurrency flag. | Tools leak between her brains; refusals come out in English; staying silent does not end her turn. | P | `tools.restrict({allow:[]})`, `register`, `guard`, `get`; `defineTool`; `exec.concludeTurn()` |
| TL-3 | Before a tool body runs, a plugin can refuse the call; the refusal becomes the tool error. A plugin can wrap the body so that its async context reaches whatever the body calls. | Tools of stale or fenced stages run; the LAN fetch policy is applied to the wrong task. | I | `tools/pre-execute`; `tools/execute` waterfall, whose last link is the body |
| TL-4 | When arguments fail validation, a plugin can tell which argument failed and why (missing, not one of, wrong type). | Her refusals fall back to English. | I | today parsed from `validateArgs` message text |
| TL-5 | The built-in todo and web tools can be configured per preset (web search off, fetch on). | — | P | `dsh-tool-todo {allowParallelInProgress}`, `dsh-tool-web {search, fetch}` |
| TL-6 | A plugin can register slash commands. It can run `/compact` on an agent and learn how many history items were compacted. | `/heartbeat` is gone; condensing a group conversation always reports nothing to compact. | I | `commands.register`, `commands.execute`; the count is parsed from `Compacted N history items` |

## LLM. Models

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| LLM-1 | Every model request (agent steps, compactions, one-shot calls) passes one global waterfall before it leaves, with its messages, system text, purpose and session id. A plugin can rewrite the request there and call the model again through the same waterfall; the agent-loop mark is carried over. Any local-path text DSH itself adds to a request, such as an image note, is produced inside the caller's async context, so the plugin's rewrite covers it too. | **Real local paths of this computer reach her model, and nothing fails.** | I | `llm/stream` with `{global:true}`; `isAgentLoopRequest`/`markAgentLoopRequest`; `fs.processPathFromHostPath`, called after the waterfall by the model runtime (a file attachment's handle text, `LlmRuntime.fileReadPath`) and by the pi-ai and DeepSeek adapters (an image's note) |
| LLM-2 | A plugin can list providers and models and read each model's context window, default max tokens, input modalities and reasoning efforts. It can read the default model selection. | Settings refuse every route; unset routes are refused. | P | `llm.listProviders/listModels/resolveModelInfo`; `agentDefaultModel.currentSelection()` |
| LLM-3 | A plugin can stream its own model request and assemble the result: blocks, usage, and a finish kind (error, aborted or max tokens). | Her own summaries fail. | P | `llm.stream`, `BlockAssembler` |
| LLM-4 | Model failures carry a stable set of codes: auth, quota, account quota, invalid credential, missing credential, rate limit, server, timeout, transport, stream closed, aborted, context window exceeded, invalid request. | Her models rest at the wrong times; refused pictures are not offloaded. | P | `LlmError` codes; `CONTEXT_WINDOW_EXCEEDED_CODE`; `errorChain` |

## CMP. Compaction

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| CMP-1 | Each preset has its own compaction engine and tool-result pruner, configured with a threshold ratio of the window, headroom beyond the output reservation, a summary cap and per-model policies. The engine measures size with the same token meter a plugin can read. | Compaction points move; sizes disagree. | P | `dsh-compaction-basic` config; `dsh-compaction-tool-result-pruner`; `tokenMeter.measure(session).totalTokens` |
| CMP-2 | A plugin can supply its own compaction summary by subclassing the engine. Automatic compaction goes through a method the subclass can override. A summary that throws leaves the conversation exactly as it was. | Her checkpoint is not hers; a failed summary damages the conversation. | I | `BasicCompactionEngine` subclass; `summarize`, `compactIfNeeded` override |
| CMP-3 | A plugin can compact a conversation now while keeping everything from a chosen sequence number verbatim. The kept tail counts toward the model's tokens. The result says what was shadowed and the compaction id; a failure says where (commit or persistence). | No turn-end compaction: her whole last turn is not kept word for word. | F | `compactNow(agent, signal, undefined, {keepFrom})`; Asuna detects it by `compactNow.length >= 4` |
| CMP-4 | A plugin can record that some images in earlier messages are offloaded, so later requests leave them out. | One refused picture fails every later turn. | I | `image/offload {targets[{seq, imageIndexes}]}`, as `dsh-compaction-image-offload` projects it |
| CMP-5 | When a request overflows the window, DSH compacts once and, if that fails, ends the turn with a context-window-exceeded error. | Her full conversation is never carried to a new one. | P | overflow compaction in the agent loop |

## SCH. Schedule

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| SCH-1 | A plugin can create plans for a session: one-shot (after N seconds) and recurring (every N seconds, daily at a time in a time zone, weekly on ISO weekdays at a time in a time zone), each with a title and a prompt. The prompt round-trips verbatim. | Her plans are not armed, or orphaned. | P | `schedule.create(sessionId, {title, prompt, after_seconds \| every_seconds \| daily \| weekly})`; `daily`/`weekly` `{time: 'HH:mm:ss', time_zone, weekdays}` |
| SCH-2 | A plan's timing can be changed in place, keeping its id, under an optimistic check, and a plan can be deleted. A plugin can list all plans with their next fire time. After a plan fires, its next fire time moves on; a finished one-shot is marked so. | Retiming becomes delete plus create; plans are duplicated or left as ghosts. | I | `schedule.update({sessionId, id, expected, change: {kind, <selector>}})`, `delete`, `list`, `catalog`; `expected` must equal the `list()` row; a finished plan's `status` is on its `catalog()` row |
| SCH-3 | A plan fires as a message in its own session's inbox. The message says it came from the schedule and which plan and occurrence it was, and a firing is distinguishable from any other schedule-sourced message. One fired plan is claimed per turn. | Her reminders never reach her worker; a change notice is taken for a firing; the reminder queue stalls. | I | `source.kind:'schedule'`; plan and occurrence parsed from the firing's `key: value` lines (`reminders_json`, or `schedule_id_json` and `occurrence_at`) |
| SCH-4 | The Web Host provides the schedule service, available within a bounded time after start. | Her worker fails to start. | P | `schedule` service from the Web bundle |
| SCH-5 | A plugin's own change to a plan (create, retime, delete) puts nothing into the session or its model's context. | Every retime of hers becomes a notice in her prompt. | P | rc.5 sends no change notice; 0.2.2 sends `[SCHEDULE CHANGE]` by `agent.inject` unless the change carries the session as `actorSessionId` |

## SVC. Host services

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| SVC-1 | A plugin can register its own web search and fetch providers; the profile chooses one by id. A fetch provider can be built on DSH's HTTP fetch with its own address resolver. A blocked non-public address fails with a recognisable code. A plugin can list the registered search providers. | DSH's own search and fetch are used; the LAN policy is wrong. | I | `web.registerSearchProvider/registerFetchProvider`; `HttpFetchProvider(limits, resolver)`; `WEB_BLOCKED_URL`; `web.searchProviders` (private) |
| SVC-2 | A plugin can list, read, change and delete credential records with any payload under its own key prefix, and resolve and set secret references. The local store can be opened offline. | Her credentials are gone. | P | `credentials.listRecords/readRecord/modifyRecord/deleteRecord/resolve/set`; `credentialKey`; `dsh-credentials-local` |
| SVC-3 | A plugin can confine a command line to one folder with workspace-write access, and probe the confinement without running anything. | Commands are unavailable, or run unconfined. | P | `sandbox.confine(argv, {mode:'workspace-write', workspaceRoot})` |
| SVC-4 | A plugin can save an image as an attachment (getting its id, type and size) and read it back. | Her pictures are unseen. | P | `attachments.saveImage`, `readImage` |
| SVC-5 | Spilled tool output can be read back from a known folder per session. | The action side cannot page long output. | I | `dsh-spill-local` `sessionDir(root, id)`; `spillStore.root` |
| SVC-6 | A plugin can expose methods that its own browser client calls through the Host's gateway. | Her settings card and memory tab are dead. | I | `TypertRemoteService`, `Remote` applied by hand; `/api` `asunaApi/<name>` |

## UI. Web UI

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| UI-1 | A plugin's browser entry is loaded with the Host's own React and DSH's UI primitives (button, input, menu, pill, disclosure row, Markdown text, settings form and fields, icons) and the client services it names. | None of her UI loads. | I | `package.json` `dsh.client`; `window.__ModuleLoader__.load`; `dsh-client-ui-primitives` exports |
| UI-2 | These slots exist and a plugin can add entries to them: right sidebar tab, plugin bundle config, composer dock, chat node, tool call view, session row leading, input permission, session header actions. | Each part of her UI is silently gone. | P | `sidebar.right.pane.tab`, `plugins.bundle.config`, `conversation.composer.dock`, `conversation.chat.node`, `tool.call.toolview`, `sidebar.session.row.leading`, `conversation.input.permission`, `conversation.session.header.actions` |
| UI-3 | A plugin can replace a shipped slot entry by its key: the turn trigger, the max-tokens notice, and the permission picker. | Her turn titles, max-tokens notice and picker revert or vanish. | I | entries `turn-trigger`, `turn-max-tokens`, the permission picker, taken over with `priority: -1` |
| UI-4 | **Inline action brain.** Inside one session's chat, a plugin can render another session's chat nodes of chosen kinds over a sequence range, with DSH's own components and menus. There is no composer, no running or holding status, no turn folding, and no effect on any model's context. | Her action brain opens in the subagent view instead of inside her chat. | F | factory `conversation.chat.content` (`variant:'fragment'`, `kinds`, `after`, `through`) |
| UI-5 | A plugin can block a session's composer with a reason it gives, and knows which sessions are shown in the main view. | The owner's typing in platform and internal conversations is recorded as the owner's words. | I | `conversation.blocks.storeFor(id).set`; `sessions.list` `retainedBy.mainView` |
| UI-6 | A plugin can show DSH's context meter for any session, its own action sessions included. | Her action brain's meter is absent. | I | today found through React internals (`ContextMeter` fiber, `memoizedProps.t`) and the `fill` class of `ui-conversation/src/client/skeleton/ContextMeter.module.css`, whose hashed name (`.JObwrW_fill` on rc.2) exists only in the built `lib/client.js`, so a spec over source sees the class but not the hash; DSH does not export it |
| UI-7 | A plugin can project its own event types into chat view nodes, anchored to a session, turn or step. | Her stage labels and the collaboration thread vanish. | I | `uiConversation.events.register` |
| UI-8 | A plugin can add a right-sidebar tab and open a session's full chat in the right pane. | Her memory tab is gone; "open the full process" fails. | I | `sidebarRightTabs.register`; `sidebarRight.openResource('dsh-resource://subagentchat/session/<id>…')` |
| UI-9 | A plugin's settings card can use DSH's settings form model over the Host's config forms, with secret fields that write credentials. | Her settings card is stuck loading. | I | `SettingsFormModel`, `SettingsForm`; `configForms.describe()`; `remote.settings`, `remote.credentials` |
| UI-10 | A plugin can register its own words per locale and follow the active locale; a missing key shows the key. | Her UI words and titles come out in the wrong language. | P | `locale.register/bind/subscribe` |
| UI-11 | The props a plugin reads in its chat node and tool call view entries stay stable: the node's data and source, the turn's data, the session, the tool name, phase, raw arguments, error flag, content and disclosure state; and the chat timeline's turns, order, status and per-step data. | Her tool rows, thread rows, repair rows and the active-brain pill break. | I | `conversation.chat.node`, `tool.call.toolview` props; `useChat` `timeline` |

## PEER. Another DSH Web Host

A channel lets the character talk to a session on another DSH Web Host over its gateway.

| ID | Requirement | Breaks without it | Kind | Binding |
|---|---|---|---|---|
| PEER-1 | A client can prompt a session on another Host over HTTP, queued after its current turn. The prompted turn's user message carries the request id. | Nothing reaches the peer, or the peer's answers are filed as asides. | I | `POST /api/session/prompt` (the gateway's `/api/<namespace>/<method>` route to the session controller's `@Remote('prompt')`), envelope `{type:'client-request', rpcId, method, payload:{args}}`, `mode:'queue'`; `user/message.source.rpcId` |
| PEER-2 | A client can follow a session on another Host as a stream: a snapshot, then each new event, with the turn-end reason. | No inbound from the peer. | I | WebSocket `/api/remote.mux`, endpoint `session/follow` |

## Coverage

A **behaviour** spec runs DSH's own packages in process (an agent loop with a scripted model, DSH's JSONL
persistence in a temporary folder, a loopback server as the model server) and checks what happens. A **source**
check reads DSH's sources for a name, key, flag or route the binding names; it catches a rename, not a change of
behaviour.

| Spec | Requirements | How |
|---|---|---|
| `trn.spec.ts` | TRN-1, TRN-2, TRN-3, TRN-4, TRN-5, TRN-6 | behaviour |
| `tl.spec.ts` | TL-1, TL-2, TL-3, TL-4, TL-5 | behaviour; TL-1 also a source check of the section names |
| `llm.spec.ts` | LLM-1, LLM-2, LLM-3, LLM-4 | behaviour; LLM-4 a source check of the failure codes |
| `wire.spec.ts` | LLM-1, SES-6 | behaviour, through the pi-ai and DeepSeek adapters |
| `ses.spec.ts` | SES-1, SES-3, SES-5, SES-6, SES-7, SES-9, SES-10, SES-11 | behaviour |
| `cmp.spec.ts` | CMP-1, CMP-2, CMP-3 | behaviour |
| `sch.spec.ts` | SCH-1, SCH-2, SCH-3, SCH-4, SCH-5 | behaviour on DSH's schedule test harness; SCH-4 a source check |
| `svc.spec.ts` | SVC-1, SVC-2, SVC-4, SVC-5, SVC-6 | behaviour; SVC-6 checks the exports only |
| `fw.spec.ts` | FW-1, FW-3 | behaviour |
| `ui.spec.ts` | UI-1 to UI-11 | source checks |
| `ins.spec.ts` | INS-1, INS-3, INS-4, INS-5, INS-6, INS-7, PEER-1, PEER-2 | source checks; INS-3 and INS-7's session folders behaviour |

Not covered yet: INS-2, INS-8, FW-2, FW-4, SES-2, SES-4, SES-8, TL-6, CMP-4, CMP-5, SVC-3; within covered
requirements, TRN-2's maintenance-as-idle, SCH-3's one fired plan per turn, SES-11 following a later preset pick, and every UI behaviour
(rendering is reviewed in a browser at the upgrade routine's review step).
