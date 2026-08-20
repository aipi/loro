# ADR-0031 — The executable extension: a process, a surface, and the harness a company builds on

- **Status:** **partially implemented — R5a shipped.** The owner decided §4.1, §4.2 and
  §4.3 on 2026-08-19, from the questions this draft blocked on; everything under "Still
  open" is still open, and a design that assumes one of those has assumed a premise
  (CLAUDE.md, top).
- **What is IN the code as of R5a** (`desktop/src-tauri/src/mcp.rs`, `ext.rs`,
  `desktop/src/extview.js`, the sixth sidebar section, the `loro://ext/<id>` tab and the
  Configurações → Extensões section): the protocol, the supervisor and the three
  surfaces, with **source = a local directory only**. Nothing is downloaded, nothing is
  built, there is no remote catalogue, and `transcriber` is not a point that exists yet.
  The `surface` point ships at v1; every other point in §12's set is **declared and
  reported as unsupported by name**, never silently dropped. `net.outbound:*`,
  `agent.tools`, `acervo.read:*` and `acervo.propose` are declared-and-recorded only:
  `ext_permit` stores the answer so the grant machinery is real and testable, and the
  install sheet SAYS that nothing is enforced yet — a permission screen implying an
  enforcement that does not exist is a state that lies.
- **The inventory, measured off the code on 2026-08-20 — what a reader can use today.**
  **13 Tauri commands** (`lib.rs:4863-4875`): `ext_list` · `ext_preview` · `ext_install` ·
  `ext_remove` · `ext_start` · `ext_stop` · `ext_view` · `ext_action` ·
  `ext_settings_schema` / `_get` / `_set` · `ext_capabilities` · `ext_permit`. **2 events**
  (`ext-state`, `ext-view-invalidated`). **An MCP client** over stdio JSON-RPC 2.0, one
  line per message: protocol revision `2025-06-18`, four `loro/*` tools
  (`describe` · `view` · `action` · `settings`), one accepted notification
  (`view_invalidated`), the namespace reserved against squatting, a bounded stdout frame
  (4 MB) and a 4 KB stderr ring, timeouts 10 s / 5 s / 30 s / 2 s and a restart budget of
  3 in 60 s. **A supervisor** with six states (`stopped` · `starting` · `running` ·
  `no_answer` · `crashed` · `blocked`), a registry keyed by id, `Drop` on the client and a
  process-tree kill at exit. **A surface renderer** (`extview.js`): 16 node kinds, 9 tone
  roles, 8 spacing steps, 4 size roles, 14 icons Loro owns, 4 host-computed facts, a
  closed list of 58 class names, and every ceiling measured rather than chosen. **Three
  surfaces**: the sixth sidebar section, the `loro://ext/<id>` screen and the
  Configurações → Extensões section. **A surface needs no program at all** — `served` /
  `viewFile` / `inline`, which is the level-1 case §5.1 did not name (§17.1). **45
  `err.ext_*` codes, each with both translations**, plus 3 reserved-and-untranslated ones
  pinned by a test. Tests added by this round: **+70 Rust, +54 JS, +5 smoke steps**, and
  no pre-existing test changed result.
- **What is still PROPOSED, and is therefore not usable:** rounds **R5b** (download +
  SHA-256), **R5c** (build from source), **R5d** (`owner/repo`@sha as a source) and
  **R5e** (the conformance kit); **9 of the 10 points** of §12 — `tools`, `facts`,
  `material`, `triage`, `observable`, `command`, `transcriber`, `renderer`, `annotation` —
  declared, reported by name, implemented by nobody (measured: `SUPPORTED_POINTS` is
  `["surface"]`); **the enforcement of a capability** (needs a sandbox this project has
  not written, §14); **the whole outbound/transcript flow of §3.8 and §4.3** —
  `loro/propose_outbound` is a name that is refused, `ext_outbound_decide` does not exist;
  `loro/propose_material`; the **image or geometry primitive** the acid test asks for
  (§17.7); §4.6's timing obligation; and the four questions under "Still open". A design
  that assumes any of these has assumed a premise (CLAUDE.md, top).
- **Two spellings adapted to the codebase's own conventions, measured rather than
  deduced:** the event names are `ext-state` / `ext-view-invalidated`, kebab-case with no
  scheme, because not one emit name in the backend contains `://`; and the sixth sidebar
  section sits behind its own `.secsep` **after LOOPS**, not "after HABILIDADES DE IA" as
  §4(a) reads — `#toolsSection` is born `hidden`, so that placement hangs a hairline
  under a collapsed void. `tools/smoke-ui.js` step `sidebar-ext` fails if it ever does.
- **One code was reserved here as unshippable and turned out to have a real trigger in
  this very round:** `err.ext_audio_network`. A manifest declaring an audio-holding point
  together with any `net.*` capability is refused at the door, before
  `err.ext_point_unsupported`, because "not supported yet" invites the person to wait for
  a round that will never grant it (BR-1 has no consent path). It therefore ships with
  its i18n pair. `err.ext_outbound_unattended`, `err.ext_toolchain_missing` and
  `err.ext_checksum` remain untriggerable and untranslated, by the same rule.
- **Corrected after an adversarial review of the R5a code (2026-08-20), and each item
  carries the measurement that found it.** None of these is a new decision; each is a
  promise of this ADR (or of ADR-0029 §R5) that the code did not keep:
  1. **The record's `id` is now a guarded name.** `.loro/ext.json` is versioned and
     declaredly untrusted, and its `id` was concatenated into system paths whose other
     end is `remove_dir_all`. MEASURED: `PathBuf::join` with an absolute right side
     DISCARDS the base, so an id of `/Users/x/Documents` deleted that folder — proved by
     a test that failed with «a folder outside the acervo was deleted by an id». The
     `rel` of the same record was already guarded, with a comment naming this threat.
  2. **The argv is revalidated on the way OUT of the record**, not only on the way in:
     `valid_argv_token` ran in `parse_manifest`, which `start_at` never called, so a
     record arriving in somebody else's change with `sh -c "curl … | sh"` was executed
     at the first click on «iniciar». One validator, two moments.
  3. **ADR-0029 §R5's «explicit second confirmation, contents named» now exists.** The
     approval is MACHINE state (`~/.loro/ext/<id>/trust.json`) because the question is
     per machine, it stores the program verbatim so an edited command asks again, and
     `install_at` records it — the install sheet IS that confirmation.
  4. **A hung program can be stopped.** «parar» was gated on `running|starting`, so the
     only control left for `no_answer` was «iniciar» — which spawned a SECOND child and
     dropped the first out of the registry, unreachable by `stop_all`. `ExtRow.canStop`
     is read from the registry, `start_at` retires the old handle first, and
     `impl Drop for McpClient` is the floor (MEASURED: a dropped client left its child
     answering `kill -0` 400 ms later).
  5. **`client_of` no longer reports a hung program as stopped** — the screen printed
     «não está rodando — inicie» under a chip reading «sem resposta» (§9: failure is a
     state, and a state must not lie).
  6. **The stdout frame is bounded.** `BufReader::lines()` builds one unbounded line;
     MEASURED against a child writing without a newline, the host's RSS grew 18 → 97 MB
     in 3 s while no line was ever delivered. `spawn_stderr_drain` reads bytes for
     exactly this reason, and its comment names the class.
  7. **BR-8: a refused notification's method is printed only when it is one of Loro's
     own reserved names.** The name is chosen by the extension's process, and it was
     interpolated into a logged field — 200 KB of transcript under a `loro/` prefix.
  8. **Two controls that did nothing now do something**, and one that lied stopped
     lying: a relative link inside a `doc` was a focusable, link-roled anchor nobody
     wired; a `loro/view_invalidated` repainted over what a person was typing; and a
     second `primary: true` button painted a second filled button with no refusal.
- **Date:** 2026-08-19 (reviewed and corrected 2026-08-20)
- **Opens:** ADR-0029 §4.3 — *"the executable class is refused by name in R1; the door
  opens later, in its own ADR (R5)"*. This is that ADR.
- **Narrows (does not revoke):** ADR-0029 §11, *"no extension point into the app itself —
  no JS injected into the webview, no new Tauri command from a pacote, no UI slots"*.
  Every clause of it survives literally (§3.1). What is added is not a slot inside the
  app; it is a **peer outside it** that describes a surface Loro draws with its own
  components.
- **Amends:** ADR-0029 §11's line *"nothing pluggable in the kernel: audio capture, the
  whisper spawn"* — narrowed to the guards, opened for the **engine**, with a mechanical
  invariant in place of the blanket refusal (§3.12). Its reason is kept verbatim.
- **Extends:** ADR-0006 (a downloaded artifact is verified against a pinned SHA-256
  before it can be used), ADR-0021 (`--permission-mode` is always the user's), ADR-0023
  (kill the process TREE), ADR-0024 (the acervo's door is one-way), ADR-0026 (a tab may
  be a SCREEN — `loro://…`), ADR-0027 (review inside the app), ADR-0029 (the pacote, the
  loop, and the grant that is asked for rather than declared), ADR-0030 (the PATH a GUI
  app never had), ADR-0022 §28 (the freeze class: a sync call on the main thread)
- **Origin — two owner observations on 2026-08-19:**

  > Com o aumento da IA, mais ferramentas estão sendo criadas […] e tem sido difícil
  > juntar tudo isso. Imagino dentro do Loro um portal de extensões: você cria a sua
  > extensão e pluga no Loro, através de um repositório do GitHub — ele mesmo compila e
  > faz o binário, baixando o que for necessário. […] Um harness confiável para empresas
  > construírem coisas dentro do próprio Loro, ao invés de fazerem forks. Plugar um RAG,
  > plugar um MCP, plugar qualquer ferramenta própria. Um Loro mais parrudo.

  > Ideal é que essa expansão apareça lateral, e tenha também o seu próprio painel de
  > extensões, onde ficam as suas configurações — como se fosse embebida ao Loro.

---

## 1 · In plain words

Today Loro can be **taught** (habilidades, seed, loops — ADR-0029) but not **connected**.
Everything a pacote brings is instruction: text the user's own agent reads. The moment a
pacote ships a program — an MCP server, a hook, a binary — Loro recognises it by name and
refuses it (`plugins.rs:36`, `EXECUTABLE_MARKERS`).

This document opens that door, and the whole design turns on one sentence:

> **An extension is a process, not code inside Loro.**

It runs beside the app, speaks a protocol over stdio, and asks for what it needs. It has
**less** power than the person's own chat: the chat can run `Bash`; an extension never
can. It draws no pixels of its own — it *describes* a surface, and Loro draws it with the
components in DESIGN.md §5, in the person's theme and language.

Three surfaces, none of them a new anatomy:

- a **lateral** row, in a sixth sidebar section `EXTENSÕES` — the same shape LOOPS got as
  the fifth (ADR-0029 §4.12);
- its **screen**, as a tab `loro://ext/<id>` — the fifth `loro://` sentinel tab in a
  pattern ADR-0026 established (§2.3);
- its **settings**, as a page in Configurações → Extensões, rendered from a schema the
  extension declares — never a form it writes.

And the honest sentence, which the install sheet must carry in the person's own words:
**installing an executable extension is trusting its author with this machine.** ADR-0029
§11 said Loro will not sandbox, because a sandbox we did not write and cannot verify is a
claim the app does not enforce. That still holds. What Loro *can* enforce is not the
process's power over the operating system — it is **what Loro itself hands it**, and that
is what §3.7 and §3.8 are about.

---

## 2 · Context — what already exists, read from the code

### 2.1 The declarative half shipped, and it works

`plugins.rs` (1302 lines) installs a pacote as a change in the working tree: preview →
triage at the door (ADR-0024) → files land uncommitted → recorded in `.loro/plugins.json`
with a per-file `sha256` → uninstall subtracts only what still hashes the same. Nothing
about that machinery is replaced here. An executable extension is a pacote **plus** a
program, and it walks through the same door.

### 2.2 The executable class is already recognised — by the tree, not the manifest

```rust
// plugins.rs:36
pub const EXECUTABLE_MARKERS: [&str; 7] = [
    "hooks/", ".mcp.json", ".lsp.json", "monitors/", "bin/", "settings.json", "agents/",
];
```

The rule that governs it survives unchanged and is worth restating, because it is the
rule this ADR leans hardest on: **a manifest is an assertion by its author; the tree is
the fact.** Everything below that reads a declaration — the capabilities, the settings
schema, the recipe — treats it as a *claim to be checked*, never as an authorisation.

### 2.3 A tab that is a SCREEN is not a new idea — it is the fifth one

The owner chose the extension's surface to be a tab in the content column. DESIGN.md
anatomy rule 2 says *"tabs are open documents only"*, and read alone that is a collision.
It is not one: the code has had screen tabs since ADR-0026, each behind a sentinel `rel`:

| Sentinel | Where | What it is |
|---|---|---|
| `loro://loop-novo` | `app.js:24` | a loop that does not exist yet |
| `loro://manual` | `app.js:5122` | the in-app manual |
| `loro://indice` | `app.js:5532` | the índice remissivo — *"uma TELA, não um arquivo"* |
| `loro://nova-nota` | `app.js:10771` | a scratch note |
| `__home__` | `app.js:2264` | the pinned "nothing open" state, never drawn |

So `loro://ext/<id>` is the **fifth** sentinel, and rule 2 needs no amendment — only the
wording DESIGN.md already contradicts in code: *tabs are open documents and screens; the
nav pill's destinations are what cannot be dismissed.* That correction is owed to
DESIGN.md whether or not this ADR is accepted (§15).

### 2.4 The permission machinery exists, and it was already built for the unbounded case

ADR-0029 §4.18 settled a question that is exactly this one, one round early: *"as
permissões podem ser infinitas"* — the set of tools cannot be enumerated, so **the ask is
the mechanism, not the fallback.** The code that implements it:

- `loops.rs:744-760` — what is granted goes to `--allowedTools`, what was refused goes to
  `--disallowedTools`, because *"the mode was never the boundary"*;
- `loops.rs:765-780` — `safe_tool_name`: a `*` is accepted only as a whole server's
  suffix (`mcp__slack__*`); a bare `mcp__*` returns empty, i.e. refused;
- `loops.rs:2361-2395` — `capabilities_of`: what a project can offer is **discovered**
  from its own `.mcp.json` plus the agent's outward tools, each carrying the pacote it
  came from. *"A connector Loro has never heard of shows up the day it is installed, with
  no release of Loro in between."*

That last line is the whole interoperability answer, and it already runs. An extension
that registers an MCP server is offerable to a loop **on install day**, through code that
exists.

### 2.5 The process primitives exist too

`proc::command` (`proc.rs:64`) is the one spawn constructor; `proc::hydrate_path`
(`proc.rs:177`) fixes the PATH once at startup (ADR-0030); `proc::gui_creation_flags`
(`proc.rs:36`) keeps a GUI launch from flashing a console; `paths::which` (`paths.rs:212`)
is the lookup a probe must share with the spawn. ADR-0023 already had to learn to kill a
process **tree** on Windows. An extension supervisor is not new plumbing — it is one more
caller of plumbing that was paid for by three previous bugs.

### 2.6 What does NOT exist

No process supervisor with lifecycle and timeouts. No MCP **client** in Loro (the agent
CLI is the client today; Loro only writes and reads `.mcp.json`). No artifact download
other than the model (ADR-0006). No build step for anything but Loro itself. No settings
that belong to something other than Loro. No remote plugin source at all —
`resolve_source` (`plugins.rs:399`) accepts a local directory and refuses `http`, `git@`,
`npm:` and `owner/repo` **by name**.

---

## 3 · Decision — the frame

Thirteen invariants: §1 the process · §2 the protocol · §3 the primitives · §4 the
surfaces · §5 settings, state and secrets · §6 the binary · §7 capabilities · §8 BR-1 and
the wire · §9 failure · §10 uninstall · §11 edge cases · **§12 the extension points** ·
**§13 what is deterministic**.

### §1 An extension is a process; ADR-0029 §11 survives clause by clause

| §11 clause | Still true? | Why |
|---|---|---|
| no JS injected into the webview | **yes, literally** | the extension emits a view *document*; Loro renders it. No script, no style, no font, no image, no URL crosses into the page |
| no new Tauri command from a pacote | **yes** | the command allowlist stays Loro's and fixed. `ext_*` commands (§6) are Loro's own, and they are the same set for every extension |
| no UI slots | **narrowed, by owner decision §4.1** | there is one surface, and it is not a slot inside Loro's screens: it is a screen **of** the extension, in a tab, drawn from a schema. Nothing is injected into Início, Organizar, Conhecimento, Revisão, the header, the panel or the footer |
| restrictive CSP is load-bearing | **yes, untouched** | no new origin, no `unsafe-*`, no remote asset. An extension that wants to show an image ships it as a document, and documents are Loro's to render |
| nothing pluggable in the kernel | **yes** | capture, the whisper spawn, the triage blocks, the path guards, the git/`gh` writes: unreachable from an extension, by absence of an API, not by a check |

**The extension is less privileged than the person's chat.** The chat runs the agent CLI
with the user's chosen `--permission-mode` and can reach `Bash`. An extension has no
execution API at all, and never will: `loro/exec` is refused at the protocol level, for
the reason ADR-0029 §4.17 gave for loops — *"arbitrary execution is the executable door,
and it does not open through a checkbox."* Here the door is open for the extension's own
binary, which the person chose to install; it does not thereby open for the extension to
run *anything else*.

### §2 The protocol is MCP plus one reserved Loro namespace

Loro invents no protocol, for the reason ADR-0029 §2.2 gave for the package format: the
thing already exists, and a private one would mean neither side could use the other's.

**An extension's program is an MCP server over stdio.** Loro becomes its second client
(the agent CLI is the first). Three consequences, and all three are the interoperability
answer:

1. **An existing MCP server is already most of an extension.** A company that has an
   internal MCP — a RAG over its wiki, a ticketing bridge, an internal search — plugs it
   in with a manifest and no new code.
2. **What the agent can reach and what the surface can reach are the same declaration.**
   One thing to review (ADR-0027), not two.
3. **The `.mcp.json` an extension registers is read by `capabilities_of` already**
   (§2.4), so its tools become grantable to loops with no release in between.

The Loro half is a **reserved namespace**, `loro/…`, of methods the host calls on the
extension and the extension calls on the host. The prefix is reserved: a server exposing a
`loro/` name that is not in the spec is refused by name at handshake
(`err.ext_reserved_name:<name>`) — the same posture as `err.plugin_schema_unsupported`.

```
host → extension                    extension → host
  loro/describe   handshake           loro/settings_changed    invalidate + re-read
  loro/view       the surface         loro/view_invalidated    "redraw me"
  loro/action     a click             loro/propose_outbound    ask to send (§8)
  loro/settings   the schema          loro/propose_material    write via the fila
```

Everything else an extension does, it does as ordinary MCP tools — which is what the
agent consumes.

### §3 The surface is composed from primitives, not chosen from a catalogue

**Owner correction, 2026-08-19:** *"não posso limitar a criatividade da pessoa em estender
o Loro […] um adaptador portátil e um contrato bem fechado para qualquer extensibilidade
que possa surgir, como o kernel do Linux faz."* An earlier draft of this section listed
seven widgets (`text`, `rows`, `state`, `list`, `field`, `action`, `doc`) and refused a
board. That is the wrong axis: a fixed widget list means every surface Loro did not
foresee is impossible, and the first unforeseen one — a kanban — broke it within a day.

The contract is therefore **closed but composable**: a small, versioned set of primitives
that compose into anything, the way a driver composes arbitrary behaviour out of a fixed
ops struct.

| Kind | Primitive | Composes into |
|---|---|---|
| layout | `stack` (vertical), `row` (horizontal), `grid` (n columns), `scroll` (its own overflow container) | a board, a timeline, a form, a table, a split |
| leaf | `text`, `badge`, `field`, `button`, `link`, `doc`, `divider`, `spacer`, `icon` (from Loro's set) | the contents of any of the above |
| binding | `each` over a facts collection (§7), `when` on a value | a column that fills itself from the acervo |

A kanban is `row` of `stack`s, each a `scroll` of cards; a card is a `stack` of `text` +
`badge` + `button`. Loro ships no `board` node and forbids no board. **What the extension
composes is its business; what it composes *from* is the contract.**

**And a composition can be named.** An extension declares its own `components` — a `card`,
a `column`, a `timeline-row` — as compositions of primitives with parameters, and uses
them like primitives. This is the open/closed half of the view contract (§14): the
vocabulary an author works in grows without a single line changing in Loro. A component
is inert data, expanded by the renderer before layout, with a depth ceiling so a component
cannot recurse into a hang.

**What the primitives constrain, and why each constraint is a guarantee rather than a
taste:**

- **Values come from the token scale, never from the author.** Spacing is a step on the
  scale, colour is a palette *role* (`ink`, `ink3`, `accent`, `line-control`), type is a
  role (`sans`, `mono`). No hex, no px, no font file, no image, no URL. This is what keeps
  both themes working, keeps 4.5:1 contrast true on the surface the text actually lands
  on, and keeps the CSP untouched — three things an author cannot re-solve per extension
  and should not have to.
- **Interactive primitives carry Loro's behaviour.** Focus ring, keyboard order, roving
  tabindex inside a `grid`/`row`, `prefers-reduced-motion`. An author composes freely and
  **cannot** compose something unreachable by keyboard.
- **A claim is attributed.** A `text` or `badge` stating a state the app cannot verify
  renders as the extension's claim, not as Loro's (DESIGN §1 — state must never lie). This
  is the one rule that constrains *content*, and it exists because the alternative is an
  app that lies on someone else's behalf.
- **Strings are pt/en pairs** (`err.ext_i18n_missing:<key>`), because the person chose a
  language and an extension is not an exception to it.
- **An unknown primitive is refused BY NAME** (`err.ext_view_node:<kind>`) and the surface
  says which — never dropped in silence (ADR-0029 §3.7).

**What is NOT constrained, deliberately:** how many actions a view has, how dense it is,
whether it shows dates, owners, counters, statistics or a board with fourteen columns.
DESIGN.md governs **Loro's** screens; it is not imposed on someone else's. The anatomy
rules that still bind are the ones about the *container* — the extension's screen is a tab
in the content column, it scrolls inside itself, and it never repaints the header, the
sidebar, the panel or another extension's surface.

### §4 Three surfaces, each an existing pattern

**(a) Lateral — a sixth sidebar section `EXTENSÕES`,** after HABILIDADES DE IA, behind
the `.secsep` hairline that ADR-0029 §4.12 introduced for LOOPS. One row per installed
extension: its name, its state dot (`rodando · parada · não respondeu`), and the ⋯ menu
the pacote row already has (*ver o que trouxe · configurar · remover*).

**(b) The screen — the tab `loro://ext/<id>`,** the fifth sentinel (§2.3). It obeys the
content column exactly as every other screen does: 700–720px, one axis (anatomy rule 11,
pinned by `tools/smoke-ui.js`), survives the panel being open with no window-width media
query.

**(c) Settings — Configurações → Extensões,** the section ADR-0029 §4.2 already created
for pacotes, gaining a page per extension rendered from its declared schema.

**Not** a destination in the nav pill (rule 2 of the anatomy; destinations are fixed).
**Not** a fifth tab in the ✦ IA panel — the strip stays four, and a surface that competes
with the Chat for 330px is a surface nobody reads.

### §5 Settings are the person's; state is the extension's; a secret is neither

The extension declares a **schema**. The kinds (`string`, `number`, `bool`, `enum`, `path`,
`host`) are validation rules rather than a vocabulary to be extended by release: a
`string` carries an optional `pattern`, so a field shape Loro never imagined validates
without a Loro release (§14). Each field has `id`, pt/en label, default, and an `escopo`:

| `escopo` | Stored at | Travels with the project? |
|---|---|---|
| `projeto` (default) | `.loro/ext/<id>/settings.json` | **yes** — it is the project's policy (ADR-0029 §4.4), so a teammate reads it in Revisão |
| `maquina` | `~/.loro/ext/<id>/settings.json` | never — and never in git |

Two refusals hold the line:

- **No field of kind `secret`/`token`/`password` exists.** BR-9. A schema that declares
  one is refused at install by name (`err.ext_settings_secret:<field>`), and the copy says
  what to do instead: use the ambient credential, exactly as `git`/`gh` do today
  (ADR-0001 §5). This is not an inconvenience to route around — it is the rule that keeps
  a versioned acervo from becoming a place credentials live, which ADR-0024 already
  guards at the door.
- **The extension cannot write its own settings.** Settings are the person's; the program
  reads them at handshake and on `loro/settings_changed`. What the program needs to
  *remember* is **state**, and state goes to `~/.loro/ext/<id>/state/` — machine-scoped,
  never versioned, inside the `GIT_IGNORED` quarantine `git.rs` already enforces.

### §6 The binary: a pinned artifact by default, a build by explicit act

Owner decision §4.2. Two paths, and the default is the one ADR-0006 already proved.

**Path A — the artifact (default).** The manifest maps platform → release asset + SHA-256.
Loro streams to a temp file, verifies the hash, and moves it into place only once
verified; a binary is only *used* when its hash matches — which is ADR-0006's exact
sentence about the model, for the same reason (a compromised mirror or a MITM cannot
substitute the file). It lands in `~/.loro/ext/<id>/bin/`, machine-scoped: a compiled
binary has no business in a versioned acervo.

**Path B — the build (a second button, never automatic).** For the case the owner named
— *"ele mesmo vai compilar, baixando tudo que é necessário"* — with five constraints, each
paid for by a bug this repo already has:

1. **A rule, not a list of blessed names** (open/closed, §14). An earlier draft named a
   closed set — `cargo`, `npm`, `go`, `make` — which is closed for modification *and*
   closed for extension: a toolchain nobody at Loro uses would need a Loro release. What
   is closed is the **mechanism**: the toolchain is a program name resolved through
   `paths::which` (never a path, never a shell), its arguments are literal argv tokens
   from the manifest (no interpolation, no `&&`, no redirection, no env injection), and it
   runs with the process PATH and nothing added. Any toolchain that fits the rule works on
   the day it exists. This grants no new power: the build step is arbitrary execution
   either way (§P1), so a name list bought nothing and cost extensibility.
2. **One lookup, shared.** The toolchain is resolved through `paths::which` and spawned
   through `proc::command`, so probe and spawn resolve through the same PATH — ADR-0030's
   entire lesson (*"a probe and its own spawn must resolve through the same lookup"*).
3. **Outside the acervo.** `~/.loro/ext/<id>/build/`. A build that writes into a versioned
   tree makes Revisão unreadable.
4. **Absent toolchain is an impedimento, named** (`err.ext_toolchain_missing:<name>`),
   never a retry — the loops lesson: *five retries spend the AI to learn what the
   filesystem already said.*
5. **The result is pinned like a download.** The built binary's SHA-256 is recorded in
   `.loro/plugins.json`, so from the run step onward the two paths are identical, and
   "which binary is this" is an audit question with an answer.

**What neither path does is pretend.** A build script runs arbitrary code by definition:
`build.rs`, `postinstall`, a Makefile. There is no sandbox (ADR-0029 §11 stands), so the
install sheet says so in one sentence and the act is deliberately harder than the artifact
path. The trust boundary is the install decision — the same boundary `brew install` has,
stated rather than obscured.

### §7 Capabilities: declared as intent, granted only when asked

The shape of ADR-0029 §4.18, reused rather than re-invented:

- **The manifest declares intent, and intent is copy.** What a manifest lists appears on
  the install sheet so the person knows what they are getting into. It grants nothing.
  *"A pacote can never ship a grant"* — and here it cannot even ship a plausible one,
  because the grant store is `.loro/`, which install destinations cannot reach.
- **The grant happens when a call is refused.** Loro denies, names what was asked, and the
  person answers once. The answer is the **project's**, stored beside the loop policy in
  `.loro/settings.json`, versioned, therefore read by a teammate in Revisão.
- **"Não" is a real answer** — it is stored, and a closed door is not "ask again next
  time" (ADR-0029 §4.18).

| Capability | What it opens | Bounded by |
|---|---|---|
| `acervo.read:<escopo>` | reading project files | the **four scopes loops already have**: `projeto`, `ideia:<slug>`, `pasta:<rel>`, `conhecimento:<slug>` — one vocabulary, not two (ADR-0029 §4.15) |
| `acervo.propose` | writing **into the fila only**, or as a pending change | never a direct write to approved knowledge, never a commit, never a push — a loop's own rule (§4.7) |
| `net.outbound:<host>` | reaching one host | a host, never `*`; a bare wildcard is refused exactly as `safe_tool_name` refuses `mcp__*` |
| `agent.tools` | its MCP tools become offerable to loops and chat | still permitted to nothing: it appears in `capabilities_of` as a tick-box, and a loop must still be granted it |

**Never offerable, by absence of an API rather than by a check:** arbitrary execution,
`audio.*`, the capture path, the whisper spawn, the triage blocks, any git/`gh` write, and
anything under `.loro/` belonging to Loro or to another extension.

### §8 BR-1 and the wire: audio never; transcript only by an act; a cycle never

Owner decision §4.3 — *permitted with per-invocation consent*. Read against BR-1 as
written, **no amendment is required**, and that is the finding, not an accommodation:

> BR-1 — *"Audio and transcripts never leave the machine by default; raw audio never
> leaves it under any circumstance. External calls exist only as an explicit,
> per-invocation, user-driven opt-in."*

So the rule already distinguishes the absolute half from the consentable half. What this
ADR must supply is that the consent is **real**, and that is four mechanisms:

1. **Raw audio has no capability and no API.** The absolute half stays absolute by
   absence, not by a flag.
2. **The extension cannot send; it can only ask.** There is no "send" in the protocol.
   `loro/propose_outbound{host, files[], why}` produces Loro's own sentence — naming the
   **host and the count**, never the content (BR-8) — and the person performs the act.
   An extension holding `net.outbound:<host>` may talk to that host on its own account;
   what it may not do is put project content on the wire without this door.
3. **An unattended cycle can never send.** Nobody watches a loop cycle, so a
   per-invocation consent has nobody to give it: `loro/propose_outbound` raised from a
   cycle is refused by name (`err.ext_outbound_unattended`) and **does not queue**. This
   is deliberately unlike §4.18's tool request, which *does* wait: a tool grant is
   standing policy, and an outbound is an act. An act that waits is an act performed later
   by someone who never read the sentence.
4. **Every send is recorded, structurally.** `~/.loro/ext/<id>/outbound.log`: timestamp,
   host, file count, byte count — never content, never a path that is itself content
   (BR-8). The extension's own screen reads it back, so *"o que já saiu daqui"* is a fact
   the app states instead of a promise it makes.

**The real risk of this decision is fatigue,** and it is answered by scope rather than by
a "sempre permitir" checkbox that would quietly become §4.9's `bypassPermissions` under
another name: **one consent covers one call.** An extension whose design needs a
continuous outbound stream is the wrong shape for Loro, and the copy says so rather than
offering a switch that makes BR-1 a formality.

**What this consciously does not fix** (stated, as ADR-0029 §4.18 stated its own): content
an extension brings back can carry **third-party personal data** into a shared, versioned
project. The intake triage screens credentials, not conversation (ADR-0024). Anything an
extension proposes therefore arrives **through the fila**, where a person sees it before
it becomes knowledge — which is the only control that actually works, and it is the one
the product already has.

### §9 Failure is a state, never a freeze

The freeze class has now been diagnosed three times in this repo (ADR-0022 §28: the live
preview ran whisper on the main thread), and it is guarded by a test. An extension is a
foreign process with a foreign author, so it gets the rule ahead of the bug:

- **Every call is async with a timeout.** Proposed floors: `loro/view` 5s,
  `loro/action` 30s, handshake 10s. Nothing in the app ever waits on an extension.
- **A program that does not answer becomes a stated state** — *parada · não respondeu* —
  on the lateral row and on its own screen, with the last time it did answer.
- **The supervisor kills the tree**, not the pid (ADR-0023, Toolhelp on Windows), on
  stop, on uninstall and on app quit. An orphaned extension holding a port is a bug the
  user cannot see and cannot fix.
- **A crash loop is a state, not a spinner.** N restarts (proposed: 3) inside a window,
  then stopped with the reason named.
- **Lazy by default.** An extension is spawned on first use, not at startup: N extensions
  must not become N processes at launch, and a stopped extension costs nothing. First run
  with no extensions is byte-identical to today, which is the offline floor ADR-0006
  requires.

### §10 Uninstall, update, and what is never deleted

Uninstall is ADR-0029 §3.5 (remove the recorded files **whose hash still matches**, report
the ones a person edited) plus: stop the process first, then remove `bin/` and `build/`.
**The data dir and the settings are not deleted** — non-destructive premise; they are
reported, and removing them is a second, explicit act. Update is a user act (no
auto-update, ADR-0029 §11), passes the same door, and shows what changed as a pending
change before anything runs.

### §11 Edge cases, each with its rule

| # | Case | Rule |
|---|---|---|
| E1 | two extensions register the same MCP server name | the second install is refused by name (`err.ext_server_conflict:<name>`). `capabilities_of` keys by server name; a silent overwrite would repoint an already-granted tool |
| E2 | an extension's id equals a builtin vertical's | it **shadows** it, the rule `presets.rs` already implements for `~/.loro/templates` — and the row says which is active |
| E3 | the acervo's agent is not Claude Code | the MCP half is the agent's; Loro's own surface still works. The copy says which half is inert (ADR-0029 §3.7) |
| E4 | the pinned SHA does not match the download | refused, temp file discarded, nothing installed. The partial file can never become the active binary (ADR-0006) |
| E5 | the repo's tag moved under a pinned sha | the sha is what is fetched and what is recorded; a tag is a label, not a version |
| E6 | the extension declares `loro: 3` and this build reads 2 | refused by name (`err.ext_protocol_unsupported:3`) — half an install is worse than none, the rule `read_manifests` already applies (`plugins.rs:394`) |
| E7 | a granted host stops resolving | `impedimento` on the row with the host named; never a retry storm |
| E8 | the person edits a file the extension installed | uninstall leaves it and says so (§10); the running program is unaffected — it reads its own dir, not the acervo's copy |
| E9 | an extension asks for `acervo.read:pasta:<rel>` and the folder is gone | `err.ext_scope_missing:<rel>` — impedimento, not failure (ADR-0029 §4.15) |
| E10 | the surface tab is open and the extension is stopped | the tab stays, states *parada*, and offers **iniciar**. A tab that vanishes under the person is a document that was clipped |

### §12 The extension points — the closed contract

The kernel analogy taken literally: a driver does not get the hardware, it **registers
with a subsystem** and implements its ops. Loro's subsystems are the points below. The
list is closed and versioned; what an extension does *through* a point is unbounded.

| Point | The extension supplies | Loro guarantees |
|---|---|---|
| `surface` | a composition of primitives (§3) | render, theme, i18n, keyboard, attribution |
| `facts` | a provider of derived facts — a new node/edge kind in the graph | schema validation; the graph never opens `meetings/`, `notas/` or the trail (BR-8, ADR-0026 §2) |
| `material` | produced material | it lands in the fila and nowhere else; a person promotes |
| `triage` | rules for the door | additive `warn` only; a block can never be relaxed (ADR-0029 §3.3) |
| `tools` | MCP tools | discovery (`capabilities_of`), and a grant that is asked for, never declared |
| `observable` | an answer to "what is the number now?" | it is called by the **loop's** clock; there is no second scheduler |
| `command` | a one-click action | it appears in the habilidade picker, runs as the user's own agent (ADR-0021) |
| `transcriber` | a **local** engine that turns audio into text | it is spawned by Loro, holds audio, and is **network-denied for its whole life** (below) |
| `renderer` | a reading surface for a file kind it declares | it consumes a document and emits primitives; it never writes |
| `annotation` | an annotation kind on the ADR-0007 layer | anchors stay Loro's; an annotation never rewrites the text it points at |

**Every subsystem is open; each one is open at a different verb.** This is the owner's
frame of 2026-08-19 — *"tudo no Loro é estendido: áudio, chat, textos, skills, e tudo
poderá ser aproveitado para criar novos produtos dentro"* — read through OCP (§14): a
subsystem is open to being **consumed, added to and composed with**, and closed to being
**replaced, intercepted or weakened**.

| Subsystem | Open — what an extension may do | Closed — never | The invariant that holds, mechanically |
|---|---|---|---|
| capture / audio | supply a `transcriber`; consume the resulting text | take over the microphone; sit between the mic and the disk; put audio on a wire | a process holding audio has **no network capability and no consent path to one** — BR-1's absolute half admits none, so this is the one mutual exclusion with no dialog |
| transcription | swap the engine for a better or another-language one, locally | remote inference | the engine is a local process Loro spawns; the model file and the spawn stay Loro's (ADR-0006, ADR-0030) |
| chat | add tools, add habilidades, offer its own conversational surface | intercept the person's turns; read history without a grant; choose `--permission-mode` | the mode is the user's, always passed explicitly (ADR-0021) |
| texts / documents | render a kind, annotate, propose edits | write approved knowledge directly | every write is a proposal through the fila or the working tree (ADR-0024, ADR-0027) |
| habilidades | author, ship, and depend on them | delete a built-in | built-ins are editable, never deletable (ADR-0005) |
| graph / facts | register a provider | read `meetings/`, `notas/`, the trail | the graph opens `contexts/**/context.md` and nothing else — BR-8 by construction (ADR-0026 §2) |
| loops | new definitions, new observables | a second clock | one scheduler, owned by the Rust core (ADR-0029 §11) |

**This amends ADR-0029 §11 on one line, deliberately.** That ADR wrote *"nothing pluggable
in the kernel: audio capture, the whisper spawn …"*, and the reason it gave was sound: *"a
pluggable kernel turns BR-1/BR-8/BR-9 from guarantees into defaults."* The amendment keeps
the reason and drops the blanket: what turns a guarantee into a default is a **replaceable
guard**, not a replaceable engine. A transcriber that is spawned locally and can never
reach a network cannot weaken BR-1 — and refusing it costs the product every language and
every model Loro itself does not ship. The refusal that replaces it is narrower and
stronger, because it is enforced at spawn rather than by the absence of a feature.

**Versioning is the "do not break userspace" half.** Each point carries its own version;
the manifest declares which points it implements and at which version; a mismatch is
refused **by name** (`err.ext_point_unsupported:<point>@<v>`). A shipped point is never
changed in place — a new version is added beside it, and the old one keeps working. This
is the only promise that makes a third-party investment rational, and it is the promise
this document is actually asking the project to make.

**A point is a registration, not an interception.** An extension never sits *in the path*
of a core operation: it cannot filter a capture, veto a write, or wrap another extension.
It contributes; the core composes. (The reason is the one ADR-0029 §11 already gave for
the kernel: an interception point turns BR-1/BR-8/BR-9 from guarantees into defaults.)

### §13 What is deterministic when the engine is not

The request names the tension exactly: *"um contrato determinístico que roda com IA
(probabilística)"*. The resolution is the one an operating system already uses — **the
boundary is deterministic; what runs inside it is not, and is never trusted to be.**

Five things Loro guarantees regardless of what any model produces:

1. **The envelope.** Which paths an action may touch, which host it may reach, where its
   output lands, which tools it may call. Enforced where the write happens, not where the
   UI asked (ADR-0024).
2. **The schema.** Manifest, settings, view primitives and facts are validated at the
   boundary and refused **by name**. Model output crossing into a view is data from an
   untrusted caller, exactly like a syscall argument: validated, never believed.
3. **The effects.** An extension proposes; a person promotes. No commit, no push, no
   promotion — so an unlucky run costs a review, never the source of truth.
4. **The record.** Every action and every cycle writes a structural record: the extension
   id and its pinned sha, the point invoked, the inputs **by id** (never content, BR-8),
   the model and effort used, the outcome, and any refusal by name. A probabilistic run is
   therefore **auditable even though it is not reproducible** — which is the honest
   guarantee, and the one that survives contact with a model.
5. **The refusal.** Every "no" has a stable name and a stable place. An extension author
   can write a test against a refusal; that is what makes the harness testable at all
   (§9's conformance kit is exactly this, mechanised).

What Loro explicitly does **not** guarantee, and must never appear to: that the content a
model produces is correct, stable between runs, or of a shape the author promised. A
contract that claimed it would be a lie with an error code.

---

## 4 · Decisions

### Decided by the owner, 2026-08-19

| # | Decision | What was chosen |
|---|---|---|
| 4.1 | where the extension appears | **its own screen, as a content tab** (`loro://ext/<id>`) — measured as the fifth sentinel-tab, so no new anatomy (§2.3). The lateral section and the settings page are the recommendation of §3.4, read from the owner's *"apareça lateral […] e tenha o seu próprio painel de extensões"*; if the intent was tab-only, §3.4(a) drops with nothing else changing |
| 4.2 | the binary's trust posture | **pinned artifact by default; build from source as a second, explicit button**, with a declared recipe, the hydrated PATH, a build dir outside the acervo, and the result pinned by hash (§3.6) |
| 4.3 | transcript on the wire | **permitted, with consent per invocation** — which BR-1 already allows as written. Made real by four mechanisms and one refusal: an unattended cycle can never send (§3.8) |
| 4.4 | **the posture of the whole thing** | **a harness, not a curator.** The contract is closed and versioned; what an extension expresses through it is not Loro's to limit. Refusals exist only where a guarantee dies (§13 of the chapters), and every taste rule was moved out of the contract on 2026-08-19 |
| 4.5 | **how far "everything is extensible" goes** | **every subsystem is open at a verb, and closed at another** — open to being consumed, added to and composed with; closed to being replaced, intercepted or weakened. Audio and transcription join the open list, under one mutual exclusion with no consent path. ADR-0029 §11 is amended on one line, keeping its reason (§3.12) |

### Recommended, pending the owner

| # | Question | Recommendation |
|---|---|---|
| 4.6 | the UI word for this unit | **extensão**, distinct from **pacote**. A pacote teaches; an extensão connects. Two words because the person's decision is different: installing a pacote is reading; installing an extensão is trusting |
| 4.7 | is an extension one class or a flag on a pacote? | **one unit, two halves.** A repo may carry habilidades, loops, seed **and** a program — that is the "super Loro" case: a company ships its knowledge, its routines and its tools as one installable thing |
| 4.8 | timeouts | 5s view · 30s action · 10s handshake · 3 restarts. Numbers are the owner's call; the shape is not |
| 4.9 | build recipes accepted in R5 | **any toolchain that satisfies the rule** of §3.6.1 — resolved by name, literal argv, no shell. Closed on the mechanism, open on the toolchain |
| 4.10 | the official catálogo | still ADR-0029 §4.13's answer: **not yet**. A private repo as a company's catálogo (R5d) is the case that matters here, and it needs no store |

### Still open — a design that assumes these has assumed a premise

1. **Does the surface tab survive an acervo switch?** A tab bound to a project's extension
   is not portable; the loop tabs have the same question and it is unanswered in code.
2. **Does an extension appear in Revisão as an author?** Its proposals arrive through the
   fila; whether a `.revcard` names the extension as origin is a design decision, and
   "de onde isto veio" is the question ADR-0029 §5.1 already asks of a habilidade.
3. **The numbers in 4.6.**
4. **Whether the conformance kit (§9) is a Loro command or a separate repo.**

---

## 5 · The protocol — the contract an author writes against

### 5.1 `loro.json` v2 (the v1 fields are unchanged and still valid)

```json
{
  "loro": 2,
  "kinds": ["skills", "loops", "program"],
  "lang": ["pt", "en"],

  "program": {
    "protocol": "mcp/stdio",
    "server": "acervo-corporativo",
    "artifact": {
      "darwin-arm64": { "asset": "acervo-corporativo-darwin-arm64", "sha256": "…" },
      "linux-x64":    { "asset": "acervo-corporativo-linux-x64",    "sha256": "…" },
      "win-x64":      { "asset": "acervo-corporativo-win-x64.exe",  "sha256": "…" }
    },
    "build": { "toolchain": "cargo", "target": "acervo-corporativo" }
  },

  "capabilities": [
    { "id": "acervo.read:projeto", "why": "encontrar o que já existe antes de propor" },
    { "id": "acervo.propose",      "why": "trazer o achado para a fila" },
    { "id": "net.outbound:acervo.interno.example", "why": "consultar o índice da empresa" },
    { "id": "agent.tools",         "why": "as buscas ficam disponíveis para loops" }
  ],

  "settings": [
    { "id": "endpoint", "kind": "host", "escopo": "maquina",
      "label": { "pt": "endereço do índice", "en": "index endpoint" } },
    { "id": "colecao",  "kind": "enum", "escopo": "projeto", "options": ["juridico", "produto"],
      "label": { "pt": "coleção", "en": "collection" } },
    { "id": "topk", "kind": "number", "escopo": "projeto", "default": 8,
      "label": { "pt": "trechos por busca", "en": "snippets per search" } }
  ],

  "surface": { "title": { "pt": "Acervo Corporativo", "en": "Corporate Index" } }
}
```

`capabilities[].why` is **copy on the install sheet**, not an authorisation (§3.7). The
`sha256` map is what makes the artifact path verifiable; `build` is what makes the second
button possible. Neither field can grant anything.

### 5.2 Handshake

Loro spawns the program, calls `loro/describe`, and checks three things against the tree
and the build, never against the manifest's claim: the protocol version (E6), the reserved
namespace (§3.2), and that the server name is free (E1). Then it passes the settings that
exist. A handshake that fails leaves the extension **parada** with the reason named — never
half-installed, never quietly inert.

### 5.3 A view, in full

```json
{ "view": [
  { "kind": "state", "tone": "ok", "text": { "pt": "3 fontes conectadas", "en": "3 sources connected" } },
  { "kind": "rows", "rows": [
      { "label": { "pt": "última busca", "en": "last search" }, "value": "14:02" },
      { "label": { "pt": "coleção",      "en": "collection"  }, "value": "juridico" } ] },
  { "kind": "action", "id": "sync", "primary": true,
    "label": { "pt": "Sincronizar agora", "en": "Sync now" } } ] }
```

Loro renders it with its own components, in the person's theme and language. The
extension never learns which theme, which is the point.

---

## 6 · IPC contract (to implement)

```
ext_list()                              → [{ id, name, version, state, origin, kinds }]
ext_preview(source)                     → manifest + class + files it would write
                                          + which path (artifact | build) + what triage found
ext_install(source, mode)               → installs; writes land as a PENDING CHANGE
ext_remove(id, also_data)               → §10
ext_start(id) / ext_stop(id)            → supervisor, async, never blocking
ext_view(id)                            → the view document (§5.3), timeout 5s
ext_action(id, action_id, values)       → a click, timeout 30s
ext_settings_schema(id) / _get / _set   → §3.5; a secret field is refused at install
ext_outbound_decide(id, req_id, allow)  → the person's act (§3.8)
```

Events: `ext://state` (running/stopped/no-answer, per id) · `ext://view-invalidated` ·
`ext://outbound-request`. Every one of them async, for the reason §3.9 gives.

---

## 7 · A worked example — `acervo-corporativo`

The case the owner named: *"plugar um RAG, plugar um MCP, plugar qualquer ferramenta
própria"*. One private repo, carrying all four kinds. Host names below are placeholders.

```
acervo-corporativo/
  .claude-plugin/plugin.json        name, version, author
  loro.json                         exactly §5.1
  commands/
    buscar-no-acervo.md             habilidade: "antes de escrever, procure no índice"
    conferir-precedente.md          habilidade: "esta decisão já foi tomada?"
  loops/
    indice-fresco.md                loop: semanal, escopo conhecimento:juridico
  src/                              the MCP server (Rust)
  README.md
```

**What the person does.** Configurações → Extensões → *instalar de um repositório* →
`empresa/acervo-corporativo`. The preview names four things: two habilidades, one loop
(disarmed), one program, and the four capabilities with the author's *why*. The triage
runs on every file that would be written (ADR-0024): a credential blocks, a CPF warns.
The files land **uncommitted**, so the team reviews the extension in Revisão exactly as it
reviews knowledge. The binary is downloaded and verified against its pinned hash.

**What they see.** A row in `EXTENSÕES`. Clicking it opens `loro://ext/acervo-corporativo`
— the view of §5.3. ⚙ takes them to its settings page: the endpoint (machine-scoped, never
in git), the collection and the top-k (project-scoped, so a teammate gets the same).

**What happens on the first search.** The extension calls out to the configured host and is
refused: nothing was granted. Loro names the ask — `net.outbound:acervo.interno.example` —
the person answers once, and the answer is the project's, versioned, readable in Revisão.

**What happens in a cycle.** The `indice-fresco` loop, once armed, cites
`buscar-no-acervo`. The tool is grantable because the extension's server appeared in
`capabilities_of` on install day, through code that already exists (§2.4). The cycle
produces material in the loop's folder, and it reaches knowledge **through the fila**, like
everything else. If it tries to send anything outward: `err.ext_outbound_unattended`. No
queue, no later.

**What the company did not do.** It did not fork Loro. It did not patch a build. Its Loro
is `brew`-installed and updates like everyone else's, and its own layer is a private repo
its own CI tests.

---

## 8 · The problems, and the answer to each

The owner asked for exactly this list. Every answer below is a mechanism in this document,
not an intention.

| # | Problem | Answer | Where |
|---|---|---|---|
| P1 | building from a repo executes arbitrary code before any permission exists | artifact + pinned SHA is the **default**; build is a second, explicit act, with a closed recipe set, no shell, and a stated sentence that installing is trusting | §3.6 |
| P2 | a running extension is arbitrary code on the machine | Loro does not claim a sandbox. What it bounds is what **it** hands over: no execution API, no audio, no kernel, capabilities granted only when asked | §3.1, §3.7 |
| P3 | supply chain — a tag moves, a release is replaced | the **sha** is fetched and recorded; per-file `sha256` in `.loro/plugins.json`; no auto-update; an update shows its diff before it runs | §3.6, §3.10, E5 |
| P4 | the toolchain is missing on this machine | `err.ext_toolchain_missing:<name>` — an impedimento with a name, never a retry | §3.6.4 |
| P5 | a GUI app's PATH is not the user's | resolve and spawn through the **same** lookup (`paths::which` + `proc::command`, hydrated once) | ADR-0030, §3.6.2 |
| P6 | an extension call freezes the app | every call async with a timeout; a slow program becomes a stated state | §3.9, ADR-0022 §28 |
| P7 | a crashed or orphaned process | supervised, tree-killed on stop/quit; a crash loop stops with the reason named | §3.9, ADR-0023 |
| P8 | protocol drift between Loro and an extension | version negotiated at handshake, refused by name; the reserved `loro/` namespace cannot be squatted | §3.2, E6 |
| P9 | an extension's UI lies, or breaks theme/a11y/i18n | it emits no pixels: a view document rendered by Loro's components; an unknown node is refused by name; a claim is attributed to the extension | §3.3 |
| P10 | a credential ends up in a versioned acervo | no secret field exists; a schema that declares one is refused at install; the intake triage still blocks at the door | §3.5, ADR-0024 |
| P11 | transcript leaves the machine | audio never (no API); transcript only by a per-invocation act; never from an unattended cycle; every send logged structurally | §3.8, BR-1 |
| P12 | third-party personal data enters a shared project | not "fixed" — **stated**: everything an extension proposes arrives through the fila, where a person sees it first | §3.8, LGPD |
| P13 | logs leak content | the outbound ledger and all extension logs are structural (host, counts, ids) — BR-8, and an extension's stdout is never echoed verbatim into Loro's log | §3.8.4 |
| P14 | first run needs a network, or N extensions slow startup | extensions are spawned lazily; the built-in verticals stay embedded; a fresh install is byte-identical to today | §3.9, ADR-0006 |
| P15 | two extensions collide on a server name | second install refused by name — a silent overwrite would repoint an already-granted tool | E1 |
| P16 | an extension wants to write knowledge directly | there is no such API: `acervo.propose` reaches the fila and the working tree, never a commit and never approved knowledge | §3.7 |
| P17 | consent fatigue turns BR-1 into a formality | one consent covers one call; there is no "sempre permitir"; a design needing a continuous stream is told it is the wrong shape | §3.8 |

---

## 9 · The harness — why a company builds *on* Loro instead of forking it

The request's real subject. Five things make the difference, and four of them exist:

1. **One repo carries the whole layer.** Knowledge (seed), routines (loops), instructions
   (habilidades) and tools (program) install as one unit (§4.5). A fork carries them as a
   patch that rots at every release.
2. **A private repo is the catálogo, with no new credential.** ADR-0029 §3.6 already
   clones with the ambient credential (BR-9). The Turbi case authenticates with what the
   machine already has.
3. **The review is the product's own.** An extension arrives as a pending change and is
   approved in Revisão (ADR-0027) — a company reviews its internal tooling exactly as it
   reviews its knowledge, with CODEOWNERS if it wants (H-4).
4. **The connector is discovered, not released.** `capabilities_of` reads the project's
   own `.mcp.json`: a tool nobody at Loro has heard of is grantable the day it is
   installed (§2.4).
5. **The one thing that does not exist yet — the conformance kit.** `loro-ext-conformance`:
   a runner that puts a candidate through the handshake, the view schema, the capability
   refusals, the timeouts and the two forbidden combinations, and prints pass/fail. A
   company runs it in CI, so *"works with Loro 0.14"* is a test result rather than a hope.
   Without it the protocol is a document; with it, it is a contract. This is the *harness
   confiável* the request asked for, and it is R5e.

### 9.6 A new product inside Loro is a combination of points

The ambition the owner named — *"tudo poderá ser aproveitado para criar novos produtos
dentro"* — has a precise meaning in this contract, and it is why the point set is worth
the design cost. The substrate is four things nobody wants to rebuild: **local capture, a
versioned knowledge base with a review, an agent, and a surface contract.** A product
inside Loro is those four with a different set of points filled:

| A product like… | The points it fills |
|---|---|
| clinical notes | `transcriber` (a medical vocabulary model) · `triage` (clinical data warns at the door) · `surface` · `material` |
| sales calls | `facts` (the pipeline) · `observable` (did the number move?) · `command` · `surface` |
| interviews | `renderer` (the CV) · `annotation` · `material` · `triage` (candidate PD) |
| an internal RAG | `tools` · `settings` · `surface` (§7) |

None of those is a fork, and none needs a Loro release. That is the whole claim of this
document, and §14's acid test is how it is checked rather than believed.

**And the closed half is not a limitation on the platform — it is the platform's
product.** The reason a company would build here instead of forking is that BR-1, BR-8 and
BR-9 arrive already true, and every product built on the substrate inherits them without
re-earning trust. The day a guarantee becomes a default, every vertical built here has to
prove its own privacy story from scratch, and the substrate is worth nothing.

**What a fork would still give that this does not: changing the kernel.** That is
deliberate and it is the trade. A fork can put audio on the wire; it also loses BR-1, BR-8,
BR-9 and every release. An extension keeps all four.

---

## 10 · Construction rounds

| R | What |
|---|---|
| **R5a** | protocol + supervisor + the three surfaces, source = **local directory only** (ADR-0029's R1 door, unchanged). Nothing is downloaded, nothing is built |
| **R5b** | the artifact path: platform map, download, SHA-256 verification, recorded hash |
| **R5c** | the build path: the closed recipe set, the shared lookup, the build dir, the impedimento |
| **R5d** | `owner/repo`@sha as a source — which is also ADR-0029's R3, and the same code serves both |
| **R5e** | the conformance kit |

R5a is the round that proves the design: if the three surfaces and the refusals are not
right with a local folder, no download makes them right.

---

## 11 · Test scenarios

Each must be shown to **fail without the fix** (CLAUDE.md §7.1.2).

- **BR-1** — an extension has no audio API: the capability name does not exist and the
  handshake refuses a manifest that asks for one.
- **BR-1** — `loro/propose_outbound` raised from a loop cycle → `err.ext_outbound_unattended`,
  and **nothing is queued** (assert the queue is empty, not merely that it did not send).
- **BR-1** — an outbound consent covers exactly one call: a second call re-asks.
- **BR-8** — the outbound ledger and the extension log contain host, counts and ids and
  **no** transcript content; an extension that prints content to stdout does not put it in
  Loro's log.
- **BR-9** — a settings schema with a `secret`/`token`/`password` field is refused at
  install by name, and nothing is written.
- **BR-9** — a private repo clones with the ambient credential; no token is requested,
  stored or logged.
- a downloaded artifact whose SHA-256 does not match is discarded and never becomes the
  active binary (the ADR-0006 property, for a new file kind).
- `loro: 3` → `err.ext_protocol_unsupported:3`, nothing installed.
- an unknown view node → `err.ext_view_node:<kind>`, **surfaced**, not dropped.
- a program that never answers `loro/view` → the state says *não respondeu* within the
  timeout, and the main thread was never blocked (the ADR-0022 §28 guard, extended).
- stop and quit kill the process **tree** (ADR-0023), asserted on Windows.
- an extension's write attempt outside `acervo.propose`'s destinations is refused **where
  the write happens**, not where the UI asked — *"a gate that trusts the frontend to have
  asked is not a gate"* (ADR-0024).
- two extensions declaring the same MCP server name: the second is refused, and the first
  extension's already-granted tool still points where it did.
- uninstall removes matching-hash files, leaves an edited file and reports it, and leaves
  the data dir unless the second act was taken.

---

## 12 · Consequences

- Loro gains a **client role** it did not have: it speaks MCP, not only writes `.mcp.json`.
  That is new surface in the core and it is the main cost of this ADR.
- The install decision becomes a **trust decision**, and the copy must say so once, plainly,
  without a warning triangle nobody reads twice.
- A company's Loro can diverge without forking — and can therefore diverge **a lot**, which
  is the goal and also the support question: *"is this Loro or is this their extension?"*
  is answered by the origin, which every row already carries (ADR-0029 §5.1).
- Three surfaces means three places a state can lie, so §3.3's attribution rule is not
  decoration.
- **The primitive set is the main design and test cost of this ADR** (§3, owner correction
  of 2026-08-19). Seven widgets would have been a week; a composable primitive set with
  keyboard behaviour, token-only values and a conformance suite is the real work — and it
  is what buys the extensibility the project asked for. It is also the piece most likely
  to need a design pass of its own before R5a, the way ADR-0029 §4.11–§4.14 did.

---

## 13 · What is refused, and what is merely Loro's own taste

An earlier draft mixed the two lists, and mixing them is the failure mode this ADR exists
to avoid: a harness that refuses on taste is a fork with extra steps.

### Refused, because a guarantee dies otherwise

- **No sandbox claim.** ADR-0029 §11 stands; the trust boundary is stated, not simulated.
- **No JS, CSS, HTML, font or remote asset from an extension.** The CSP is load-bearing.
- **No execution API.** `loro/exec` does not exist and will not: the extension's own binary
  is what the person installed; running *anything else* on Loro's behalf is not.
- **No audio on a wire, ever, and no consent path to one.** BR-1's absolute half. A
  process that holds audio — including a `transcriber` — is network-denied for its whole
  life, refused at spawn by name (`err.ext_audio_network`). This is the one mutual
  exclusion in the whole design with no dialog, because the rule it enforces admits none.
- **No taking over the capture.** An extension may replace the *engine*; it never sits
  between the microphone and the disk, and it never decides whether a recording happens.
- **No direct write to approved knowledge, no commit, no push.** Everything arrives as a
  proposal, through the doors ADR-0024 and ADR-0027 already guard.
- **No weakening of a guard.** Triage blocks, path guards, `GIT_IGNORED`, the capture
  path: additive only (ADR-0029 §3.3).
- **No credential storage, in any field** (BR-9).
- **No second scheduler.** The loop's clock is the only one (ADR-0029 §11).
- **No repainting of Loro's own chrome** — header, sidebar, panel, another extension's
  surface. An extension owns its screen and nothing else.
- **No auto-update, no auto-build.** Both are acts.

### Not refused — Loro's taste, which is not the extension's to inherit

These bind Loro's own screens (DESIGN.md) and are **explicitly not imposed** on an
extension's surface. If an author ships a board with owners, due dates, counters and a
statistics header, that is their product decision and their users':

- one primary action per screen; no dashboards or statistics; no activity feed;
- no artwork, no ratings, no store vocabulary;
- the 720px column and the density rules of DESIGN §7;
- what a card, a column or a status *means* — the whole question of the previous round.

Loro's answer to a surface it disagrees with is **origem** (every row already says which
extension something came from) and **uninstall**, never a schema that makes it
unexpressible.

### Still not in scope for R5

- **No hosted registry, no store.** A git repository is the distribution mechanism.
- **No new destination in the nav pill, and no fifth tab in the ✦ IA panel** — a
  container decision, revisitable, not a refusal of anything an extension might do.

---

## 14 · Open/closed — the audit, and the acid test

CLAUDE.md §4 already binds this project to SOLID, and the owner named the principle
directly on 2026-08-19. For an extension harness, OCP is not a style note — it **is** the
specification, and it cuts in both directions:

- **Closed for modification:** the core's guarantees cannot be edited by an extension.
  BR-1, BR-8, BR-9, the capture path, the guards, the doors. This is chapter 13's first
  list, and every item there exists for this reason.
- **Open for extension:** a *new kind of extension nobody imagined* must ship **without a
  Loro release.**

### The acid test

> Name the extension. Ask: does it need a change inside Loro to exist? If yes, the
> contract has a hole — and the hole must be named, not worked around.

The abstraction layer is the **point set** (§12). Adding a *point* is modifying the
framework; adding an *implementation* of a point is not, and that is OCP satisfied — the
same way a new driver needs no kernel patch while a new *subsystem* does. So the point set
must be few and expressive, and the audit below is how that claim is checked rather than
asserted.

### The audit — where the first draft failed it

| Thing to extend | First draft | After the audit |
|---|---|---|
| a surface Loro never imagined (a board, a timeline) | seven fixed widgets → **needed a release** | primitives + author-declared `components` (§3) |
| a build toolchain | a blessed list of four → **needed a release** | a rule about the mechanism (§3.6.1) |
| a settings field shape | six kinds → **needed a release** | kinds as validation rules, `pattern` on `string` (§3.5) |
| a connector / tool | already open — discovered from `.mcp.json` (ADR-0029 §4.18) | unchanged, and it is the model the rest now copies |
| a fact in the graph | — | the `facts` point: an extension registers a provider |
| a new **point** | a release | correct, and deliberate: the points are the abstraction |
| a guarantee | impossible | correct, and deliberate: that is the closed half |

### The audit — where R5a fails it, MEASURED and named rather than worked around

| Thing to extend | R5a | Verdict |
|---|---|---|
| a map, a chart, a diagram, a QR code | `VIEW_KINDS` has 16 kinds and not one paints a raster or a vector; `icon` resolves only against `ICONS_ALLOWED`, a closed list of 14 names Loro owns; the layout nodes expose `gap`/`align`/`size` and no width, no coordinate, no position | **A HOLE, and it is the acid test's own answer: yes, it needs a change inside Loro.** The author's only fallback is an image inside a `doc` node, and `stripDoc` removes EVERY image regardless of scheme — including a `data:` URI the app's own CSP already permits (`img-src 'self' data:`) — with no error code, because §1.3 decided that content inside a `doc` is stripped and not refused (`extview.test.js` pins `errors: []` for that case). So a map renders as the bare word "mapa". Adding an `image` or a geometry primitive is ADDING A POINT-LEVEL PRIMITIVE, which is modifying the framework: it is the owner's decision, not an implementer's, and it is **open** |
| enforcing a capability the person refused | `ext_permit` stores the answer and nothing reads it at a decision site (`grep -n 'decision' ext.rs` outside tests: a struct field, a write in `permit_at`, a read for display). The child is spawned by `proc::command(&exe).current_dir(&cfg.cwd)` — no `env_clear`, no sandbox, no network denial — so a started program runs with the person's own access | **Declared-and-recorded only, as the top of this ADR says.** What changed after review: the two screens that carried this now SAY the second half out loud. The earlier copy asserted that "an extension has no way to read your project", which was true of Loro's API and false of the process, next to a «recusar» button that enforces nothing — a control reporting a state it does not enforce (DESIGN §1). Enforcement needs a sandbox and is **open** |

### Eating our own contract

The strongest check available, and the one this ADR proposes as a construction rule for
R5a: **Loro's own screens should be expressible through the points.** The índice remissivo
is a `facts` provider plus a `surface`; the Loops panel is a `surface`; the intake triage
is a `triage` provider. They will not be *reimplemented* as extensions — that would be
overengineering, and the kernel does not ship its own drivers as modules to prove a point.
But if one of them **cannot be expressed** in the contract, the contract is too weak, and
that is a defect found before a third party finds it. Each is a test in the conformance
kit (§9), written against Loro's own surfaces.

---

## 15 · Alternatives considered

- **A fixed catalogue of widgets** (the first draft of §3: seven node kinds, and a board
  refused on the grounds that it would become Jira). Rejected by the owner on 2026-08-19,
  and correctly: a harness that decides what an extension may *mean* is a fork with extra
  steps. Whether a board carries an owner and a due date is the author's decision and
  their users' — Loro's answer to a surface it disagrees with is **origem** and
  **uninstall**, not an unexpressible schema. The cost of the correction is real and is
  stated in §12 of the consequences: a primitive set is a far larger design and test
  surface than seven widgets.
- **A WebView per extension, or JS in the main webview.** Rejected: it is exactly what
  ADR-0029 §11 forbade, the CSP is load-bearing, and an author would own a11y, theming and
  i18n that Loro must own once. The view schema costs expressiveness and buys the app back.
- **A Loro-specific RPC protocol instead of MCP.** Rejected for ADR-0029 §2.2's reason: the
  ecosystem's servers would not be usable, and ours would not be usable by it. The whole
  "plug an MCP" case evaporates.
- **Build from source always.** Rejected as the *default* (kept as the second button):
  it breaks the offline floor, needs a toolchain, and is *more* arbitrary execution than
  the pinned artifact it would replace — audit-ability of the source is not the same as
  safety of the build.
- **Capabilities declared in the manifest and granted at install.** Rejected: it is the
  install-sheet audit ADR-0029 §3.2 already rejected, and ADR-0029 §4.18 already replaced
  it with the ask.
- **Extension surface in the ✦ IA panel.** Rejected: 330px against the Chat, and the strip
  is already four tabs; the owner chose the content tab, and §2.3 shows it costs no new
  anatomy.
- **Mutually exclusive `transcript` and `net.outbound`.** Considered and **not** chosen by
  the owner (§4.3); the per-invocation act is BR-1's own wording, and §3.8's four
  mechanisms are what make it more than a dialog.

---

## 16 · Docs sweep (CLAUDE.md §8.9)

On acceptance, and not before: `docs/ARCHITECTURE.md` (§4 IPC — the `ext_*` commands and
the three events; §7 — the security posture gains the trust boundary sentence);
`docs/DESIGN.md` (anatomy rule 2's wording, which the code already contradicts with five
sentinel tabs — §2.3; the sixth sidebar section; §8's "what does not go in" gains the view
schema's five refusals); `desktop/src/manual.pt.md` + `manual.en.md` (what an extension is,
what installing one means, and how to take one out); `README.md`; and ADR-0029 §4.3, which
gets a line pointing here.

**DONE for R5a on 2026-08-20**, and the sweep corrected the plan in three places rather
than executing it literally — noted here because the next round starts from this list:

| Planned | What was actually written, and why |
|---|---|
| ARCHITECTURE §4 gains "the three events" | **Two** events exist (`ext-state`, `ext-view-invalidated`); the third (`ext://outbound-request`) belongs to the outbound flow, which R5a does not implement. Writing three would have documented a channel that emits nothing |
| ARCHITECTURE §7 gains "the trust boundary sentence" | one sentence could not carry it honestly. §7 now names the boundary as **stated, not simulated** and lists both halves: what is mechanical (no API, the guarded id, the argv revalidated out of the record, the per-machine approval, BR-1/BR-8/BR-9 at the door) and what is **not enforced** (a refused capability blocks nothing without a sandbox) |
| DESIGN rule 2's wording, "five sentinel tabs" | measured before rewriting: `grep -o 'loro://[a-z-]*' desktop/src/*.js \| sort -u` returns **five** rels *including* `loro://ext/` — so it was **four** that already contradicted the rule, and the model holds a sixth non-file rel (`__home__`) that is deliberately never painted. Rule 2 now separates *painted* from *held*, which is the distinction that made the old wording wrong |

Also swept, beyond the plan: DESIGN §5 gained the renderer's two lists (what is imposed on
a third-party surface and what is deliberately not — §17.4 is why that section exists),
DESIGN rule 12 went from five sidebar sections to six, README's security section gained the
peer-process line and its documentation table gained `examples/extensions/`, and ADR-0029
§11 gained the amendment note for the transcription engine (§12) next to the sandbox line
that R5a keeps literally true.

---

## 17 · What the implementation taught

In the spirit of ADR-0029 §14. R5a was built in four batches, integrated, then reviewed
adversarially; this section is what the code knows that the document above did not.
**Every line carries the measurement that proved it** — where a number is missing, the item
says so and is listed in §17.6 as an assumption.

### 17.1 Where this document and the code diverged

| The document says | The code does | The measurement that decided it |
|---|---|---|
| §6: events `ext://state`, `ext://view-invalidated`, `ext://outbound-request` | `ext-state` and `ext-view-invalidated`; no third | not one emit name in the backend contains `://`. Kebab-case with no scheme is the codebase's own spelling, and inventing a second one for this feature would have been a convention nobody else follows |
| §6: `ext_view(id)`, `ext_action(id, action_id, values)`, `ext_install(source, mode)` | `ext_view(id, lang)`, `ext_action(id, action, values, lang, now)`, `ext_install(source, hoje)` | the backend has **no locale and no clock**: `loops.rs:166-173` — "local civil time — supplied by the caller, never read from the system here". A command list written without that convention would have made this module the one place that reads the system clock |
| §6: `ext_outbound_decide`, and §3.8's four outbound mechanisms | absent. `loro/propose_outbound` is in `LORO_RESERVED_KNOWN` — a name that is **refused**, not a method that is missing | the outbound flow is BR-1's consented half; with no round to grant it, a command for it would be a control that does nothing (DESIGN §1) |
| §6 does not list them | `ext_capabilities` and `ext_permit` exist (13 commands, `lib.rs:4863-4875`) | §3.7's grant machinery is testable only if the answer is stored somewhere. It is: `AcervoSettings.ext`, read-modify-write. It enforces nothing, and now the screens say so |
| §6: `ext_settings_schema/_get/_set`, and a facts door implied by §2.1 | there is deliberately **no `ext_facts`**: the facts travel inside the `ext_view` reply | one `acervo::brain_knowledge_graph()` per view call, host-side. Two doors to the same question is two answers to it — and it is what lets a view be tested with a literal facts object |
| §4(a): the sixth section sits "after HABILIDADES DE IA" | it sits after **LOOPS**, behind its own `.secsep` | `#toolsSection` is born `hidden` (`index.html:212`) and the app's only hairline sat before LOOPS (`style.css:3206`), so the planned placement hangs a line under a collapsed void. `tools/smoke-ui.js` step `sidebar-ext` fails if the new hairline's previous sibling has no height |
| §5.1's manifest: a `program` is what a surface is drawn from | a surface has **three** sources: `served` (asked of the program), `viewFile` (a document in the package), or `inline`. `served` without a program is `err.ext_surface_unserved`; two sources at once is `err.ext_surface_ambiguous` | the level-1 case the document never named: `examples/extensions/hotspots-board` is a **12-line `loro.json` plus a 53-line document, and no code at all** — and it paints a kanban. The most valuable extension class in R5a turned out to be the one with no process in it |
| the Status above reserved `err.ext_audio_network` as unshippable, and §11's edge case E9 names `err.ext_scope_missing:<rel>` | `err.ext_audio_network` **ships, with both translations**; `err.ext_scope_missing` does not exist anywhere in the code (measured: 0 occurrences) | a code with a trigger and no translation paints raw `err.…` at a person. `ext.rs` raises the audio one for real, and BR-1 has no consent path, so "not yet" would invite waiting for a round that will never come. `err.ext_scope_missing` belongs to `acervo.read:pasta:<rel>`, a capability that grants nothing in R5a, so nothing can raise it. The other three reserved codes (`outbound_unattended`, `toolchain_missing`, `checksum`) stay untriggerable and untranslated, pinned by a test that fails if any of them gains a trigger without a pair |
| §5.2: the handshake checks "the server name is free" | it does, and the surface tab's **title comes from `ExtRow.name`**, not from `ExtSurfaceDecl.title` | the trail says `extensões/<nome>`; a tab named by a field the extension controls would let two extensions paint the same tab name. No frozen type changed |
| §3.1's worked manifest: `args` plus `cwd: "server"` | the example is inconsistent, and the one in the tree is right | measured at `ext.rs:1639-1649` and `:1855-1858`: the child's cwd is the package root, or `program.cwd` inside it, and `args` goes verbatim — so a relative token resolves against the spawn cwd. `args: ["server/main.py"]` with **no** `cwd` is correct; the §3.1 spelling would have asked for `server/server/main.py` |
| §3.5: machine state is safe because it is "inside the `GIT_IGNORED` quarantine" | it is safe because it is **outside the repository** | `GIT_IGNORED` has 14 entries and not one is `.loro/ext` (`git.rs:2014-2029`), and `~/.loro/` is not in the acervo at all. The inverse matters more: `<acervo>/.loro/ext/**` **is** versioned, which is exactly what `escopo: projeto` wants — a teammate reads the same setting in Revisão. Both halves are now a test, not an accident |
| §3.5: `pattern` on a `string` field | implemented as a hand-written, anchored, non-backtracking matcher | there is no regex engine in the crate — `Cargo.toml` lists tauri, serde, serde_json, tracing, portable-pty and windows-sys and nothing else — and adding a dependency is a contract change, not a local edit. A field that declares a `pattern` and never checks it is a control that lies, so the cheap way out was not available. Catastrophic backtracking would also have been the ADR-0022 §28 freeze class, in a new place |

### 17.2 What the adversarial review found, as classes rather than lines

Every one was reproduced before it was fixed, and every fix carries a test that was watched
go red without it (CLAUDE.md §7.1.2).

1. **An untrusted field reached a path constructor — and the other end was
   `remove_dir_all`.** `.loro/ext.json` is versioned, so its `id` arrives in somebody
   else's commit. MEASURED: `PathBuf::from("…/.loro/ext").join("/private/tmp/absoluta")`
   → `/private/tmp/absoluta` (an absolute right side **discards** the base) and
   `join("../../vitima")` → `…/vitima`. With the guard disabled the new test failed with
   *«a folder outside the acervo was deleted by an id»*. The `rel` of the same record was
   already guarded, with a comment naming this exact threat — **the guard existed and the
   sibling field did not have it.** The lesson is the shape of the fix: one validator
   (`valid_ext_id`, the exact shape `slugify` produces), one choke point (`find_record`),
   and the two constructors that build outside the project return `Result`.
2. **A validator that runs on the way IN is half a validator.** `valid_argv_token` was
   reachable only from `parse_manifest`, and `start_at` never called it, so a record
   carrying `sh -c "curl … | sh"` was spawned at the first click on «iniciar»
   (`mcp.rs:446-450` re-guards only the *command*). One function, **two moments**:
   manifest read, and out of the record before the spawn. `validate_program` now refuses
   with `err.ext_program_arg:curl|sh`.
3. **A control gated on a *deduced* state is a control that disappears when it is most
   needed.** «parar» was offered for `running|starting`, so a program that had stopped
   answering left only «iniciar» — which spawned a **second** child and dropped the first
   out of the registry, unreachable even by `stop_all`. `ExtRow.canStop` is now read from
   the registry (is there a live handle?), `start_at` retires the old handle first with a
   `take_client` that deliberately does **not** reset the crash-loop budget, and
   `impl Drop for McpClient` is the floor. MEASURED without the Drop: *«pid 59437 survived
   the drop of its McpClient»*.
4. **An unbounded read is a denial of service with no timeout to catch it.**
   `BufReader::lines()` builds one unbounded `String`. MEASURED against a child writing
   without a newline: host RSS 18 → 34 → 50 → 66 → 81 → 97 MB in 3 s, no line ever
   delivered, reader never ended. Deadlines bound the *wait* for a reply, never the growth
   of a buffer. `next_frame(&mut r, MAX_FRAME_BYTES)` fixes it, and the sibling
   (`spawn_stderr_drain`) reads **bytes** for the same reason — measured on macOS 25.6, an
   undrained stderr pipe wedges the child after 17,408 bytes.
5. **BR-8 leaks through a field a peer chooses.** A refused notification's `method` was
   interpolated into a log line; the name is chosen entirely by the extension's process, so
   `{"method":"loro/<200 KB of transcript>"}` was a content leak with Loro's own prefix on
   it. Now: `method_shape_ok` (≤80 bytes, name alphabet) before the queue, and the name is
   printed **only** when it is one of Loro's three reserved names — anything else logs
   `bytes = m.len()`. A test pins that there is exactly one interpolation in the module.
6. **A screen may not assert a containment the process does not have.** The permissions
   sheet said an extension "has no way to read your project" — true of Loro's API, false of
   the process — next to a «recusar» button that enforces nothing. MEASURED:
   `mcp.rs:444-460` spawns with no `env_clear`, no sandbox, no network denial;
   `proc.rs:64-77` removes 8 `CLAUDE_*` variables and nothing else. Both copies (sheet and
   Configurações) now say both halves, in both languages. **Two false claims on one sheet
   was the worst defect of the round, and it was a copy defect, not a code defect.**
7. **The specificity of a host stylesheet beats the specificity of a guest alphabet.**
   MEASURED in the real DOM: inside `#brainDoc` (class `doc reader`), `.doc p` and `.doc hr`
   are class+type (0-2-0) and beat a single class — a declared `gap: 0` painted **8.7px** of
   hidden margin and a 4px rule painted 16px. The alphabet's promise ("the author asks for a
   role and Loro paints it") was false for two nodes until the selector had two names. A
   value alphabet is only as closed as the sheet that renders it.
8. **A repaint is an interruption.** A `loro/view_invalidated` arriving while a person typed
   in one of the extension's own fields repainted over the keystrokes. The guard is the same
   one `refreshExt` already had — and the notice is not dropped, it waits in
   `extViewPendente` and paints on `focusout`.
9. **A badge is a sentence, and a sentence in a `flex: none` box has no way to shrink.**
   Found by measuring at 880px, not by review: the surface tab's `#bBadge` carried the whole
   explanatory phrase inside `.badge` — **373px in a 355px strip, 72px outside it, 71px of
   horizontal scroll on `#wsBody`**. Shortened to «tela de extensão» / «extension screen»:
   measured 71px → **0**.

**And one defect that was not real, which is why the rule is to measure both directions.** A
review finding said a `data:` image inside a `doc` node is dropped without an error code,
contradicting the comment. The code is right by §1.3 (content inside a `doc` is *stripped*,
not refused) and an existing test pins `errors: []` for that case; emitting a code would
have required loosening a passing test. The real defect was the **claim**, and it was fixed
in the comment, in DESIGN rule 13 and in both manuals.

### 17.3 What the kanban taught the contract

`examples/extensions/hotspots-board` was written as the acceptance case for the whole
primitive set — pasted into the test suite as a literal document, so a hole in the contract
shows up as a failing test rather than as a note in a review.

- **`each.as` is not sugar; without it the board is impossible.** A nested `each` must read
  the outer row (`col.context` inside the column, `hs.hotspot` inside the card), so the
  binding name is required rather than defaulted.
- **A `where` filter is what keeps a surface from lying.** The board leaves out a context
  with zero hotspots, because an empty column claims something about the acervo that is not
  true. The test fixture carries a zero-hotspot context precisely to prove the filter runs.
- **The ceilings had to be measured against a real composition, not chosen.** The kanban
  measures **11 levels deep**, which is why `MAX_NEST` is 128 and not 16: MEASURED, with the
  ceilings removed, a component whose body is a `use` of itself throws
  `RangeError: Maximum call stack size exceeded` **inside a painter** — an uncaught throw,
  so the surface goes blank and says nothing. `MAX_DEPTH` alone returns
  `err.ext_view_depth:8`; nothing else covered a 2000-node chain with no `use` in it.
- **The facts are the host's, and their shape is the graph's — not the shape a view would
  like.** Measured while writing the fixture: a hotspot has **no title of its own**
  (`struct DocHotspot { id: String }`, `acervo.rs:2401-2403`), so a row's `title` is the
  NODE's title; the path prefix is not always `contexts/` (`paths::contexts_dir` also
  resolves the legacy `contextos`); and an orphan's context is looked up from the node the
  graph already built, never parsed out of a path. A contract that had promised a hotspot's
  own title would have promised data the app does not have.
- **The example's copy carries a usability sentence the schema could not.** The board says,
  in both languages, that the columns are computed and **nothing here is dragged** — moving
  a point means editing the document and sending it for review. A surface that looks like a
  board invites a drag; the honest answer was a sentence, and it belongs to the author, not
  to Loro.
- **One cosmetic issue is left, named rather than worked around:** in a column, an
  `.extv-stack.al-start` makes a `divider` shrink to its content (`align-items: flex-start`),
  so the rule reads short. It is not cut. `align` is the author's role and the class list is
  closed — changing that is a design decision, not a repair.

### 17.4 The primitive alphabet turned out to be Loro's taste in two places

§13 lists what is refused (a guarantee dies otherwise) and what is merely Loro's taste and
therefore **not imposed** on a third party's surface. Building it moved two items across
that line, and the honest thing is to say which:

1. **One primary action per screen IS imposed.** §13 listed it as taste; the renderer
   refuses the second `primary: true` by name (`err.ext_view_value:button.primary`) and
   paints it as an ordinary button. MEASURED before the fix: two filled buttons, zero
   refusals. The count is taken at **paint** time, because one component used twice paints
   two buttons from a single declaration. The reason it survived as a refusal: two filled
   buttons is the screen claiming both are THE action, which is a state that lies (DESIGN
   §1) rather than a matter of taste.
2. **The 700px reading column IS imposed** — by the container, not by a rule. The surface
   renders inside `#brainDoc`, the same `.doccard` every document uses, so §7's density and
   containment rules apply whether the author wanted them or not. That is also why every
   layout node carries `min-width: 0`: without it one long token in a data row pushes the
   page sideways (the measurement `.doc` already carries at `style.css:203-213`).

The other two items on that list stayed genuinely open, and the board proves it: what a
card, a column or a status *means* is the author's, and a dense board with counters is
expressible with no change to Loro.

### 17.5 The `contract §N` citations, and where they resolve

R5a was implemented against a **frozen surface contract** that was passed to the batches and
is not a file in the repository, and the code cites it **17 times** (measured:
`grep -o 'contract §[0-9.A-Za-z]*'` over `ext.rs`, `mcp.rs`, `extview.js` and the two test
files). CLAUDE.md §2 makes a citation with no file resolvable through a map, exactly as
ADR-0001 does for the pre-baseline ADR numbers — so this is that map. **The normative text
is this ADR plus the code; the contract's numbering survives only in comments.**

| Cited as | What it is | Where it lives now |
|---|---|---|
| `contract §1`, `§1.1` | the view document and its closed value alphabet | §3 above; `extview.js` `TONES`/`STEPS`/`SIZES`/`ALIGNS`/`FAMILIES`/`ICONS_ALLOWED`; DESIGN §5 |
| `contract §1.3` | a `doc` node is CONTENT: an image and an external address are **stripped**, not refused, and the strip happens on the markdown source | `extview.js` `stripDoc`; DESIGN §8 |
| `contract §1.5` | the ceilings (2000 nodes, depth 8, 64 children) | `extview.js` `MAX_*`; `ext.rs` `VIEW_NODE_MAX`, `VIEW_TREE_DEPTH_MAX` |
| `contract §1.7` | the kanban acceptance document | `examples/extensions/hotspots-board/surface/board.json`, pasted literally into `extview.test.js` |
| `contract §2.1` | the four host-computed facts | `ext.rs::facts_from_graph`; `extview.js` `FACTS` |
| `contract §4`, `§4.2`, `§4.6` | the wire: JSON-RPC framing, the literal notification line, the protocol revision, the four timeouts | `mcp.rs:60-108` |
| `contract §5.5` | the supervisor: the keyed registry, `sweep`, the restart budget | `ext.rs` `RESTART_MAX`/`RESTART_WINDOW_MS` and the registry rules at the head of the module |
| `contract §8`, `§8.C` | the frozen public surface of `mcp.rs`, and the frozen class list | `mcp.rs` module head; `LoroExtView.CLASSES` (58 names) |
| `contract §9.C` | the frozen test titles (pt-BR on purpose) | `extview.test.js:1-17` |

### 17.6 What is still an assumption, named as one

1. **The four wire timeouts are not measured against a real extension.** `mcp.rs:75-100`
   carries real numbers — round trip on a running fixture server n=300 p50 0.011 ms / p95
   0.019 ms / worst 15.6 ms; spawn + first `initialize` n=10 p50 13.6 ms / p95 17.6 ms — but
   they come from **fixture** servers, not from `examples/extensions/mcp-python`, which did
   not exist when the module was written and does now. §4.6's obligation is therefore
   **OPEN**, and the comment says so instead of pretending a number from elsewhere satisfies
   it. `RESTART_MAX` 3 and `RESTART_WINDOW_MS` 60 s remain §4.8's proposal, unmeasured.
2. **The MCP protocol revision is frozen by assumption.** `PROTOCOL_VERSION = "2025-06-18"`
   had nothing in this repo to be measured against (`ai.rs:457` still hardcodes
   `mcp_available: false`), so it is declared in one place and a server answering another
   revision is refused by name.
3. **The end-to-end path has never been seen running inside the app.** `ext_start` →
   `initialize` → `loro/view` has 60+ unit tests, a smoke double, and a real Python server
   proven **outside** Loro (`tests/protocol_test.py`, 28 test functions, with `agent/consume.py`
   driving the same server as a plain client), but `LORO_SELFTEST=1` was not
   exercised in this round — the selftest starts a real capture, and the `syscap` sidecar
   records live audio from the machine it runs on. What was run instead is
   `tools/smoke-ui.js`: the real `index.html` and `app.js` in a headless Chrome, 32 steps,
   which is the harness that catches a loading defect. **Somebody still has to run the
   binary.**
4. **Three process tests in `mcp.rs` are `cfg(unix)`.** On Windows the 13 pure ones remain
   and the `taskkill /T /F` path has no fixture — ADR-0023's tree kill is asserted for the
   agent, not yet for an extension's child.
5. **Seven `cargo clippy --all-targets` findings are pre-existing** (`acervo.rs` ×2
   duplicated attribute, `loops.rs` ×4 `cloned_ref_to_slice_refs`, `lib.rs` ×1 unused
   variable) — proved pre-existing by re-running against a stashed tree. `make lint` does
   not pass `--all-targets`, so it is green; the debt is real and belongs to whoever touches
   those files next.
6. **At 880px the app has layout defects that predate this round** (`header-sem-sobreposicao`
   and `sidebar-loops` fail at that width; `tauri.conf`'s floor is 860px). The extension
   screen itself measures **0px** of horizontal scroll there after the badge fix.
7. **`<acervo>/.loro/ext/<id>/settings.json` is versioned** — deliberately, so a teammate
   reads the same project-scoped setting in Revisão. What does **not** travel is the
   execution approval (`~/.loro/ext/<id>/trust.json`), which is the field that would
   otherwise let a commit start a program on somebody else's machine.

### 17.7 The one thing the acid test answered "yes" to

§14's acid test asks: *name the extension; does it need a change inside Loro to exist?* For a
**map, a chart, a diagram or a QR code** the answer is **yes**, and R5a does not work around
it. MEASURED: `VIEW_KINDS` has 16 kinds and not one paints a raster or a vector; `icon`
resolves only against 14 names Loro owns; the layout nodes expose `gap`/`align`/`size` and no
width, no coordinate, no position; and the only fallback — an image inside a `doc` — is
stripped regardless of scheme, **including a `data:` URI the app's own CSP already permits**
(`img-src 'self' data:`). So a map renders as the bare word "mapa". Adding an `image` or a
geometry primitive is adding a **point-level primitive**, which is modifying the framework:
it is the owner's decision (§4), it is named in DESIGN rule 13 and in both manuals, and it is
the most likely first item of R5b.

### 17.8 The kanban round (2026-08-20) — the first extension the harness had to survive

The owner sent a screenshot of the board broken and three corrections in one breath: *«tá
muito quebrado! Ele pode ocupar a tela toda interna e ter scroll»*, then *«faça o kanban de
pontos em aberto, em pauta, em resolução e concluído, e ao invés de mostrar tudo, coloque
uma busca. Faça uma interação com o chat que produza algo»*, then *«pense nos mesmos
limites ao MCP»* and *«add algum ajuste — preciso ver até onde é possível ajustar»*. Each
one changed the contract, and each change carries its measurement.

**The defect, measured before the fix.** At the owner's real scale (80 contexts, 312
hotspots, counted from `~/.loro`'s active acervo by folder walk) the horizontal scroller's
children kept `flex-shrink: 1`: the row stayed at the scroller's 638px while its content
asked 1874px, and **79 columns painted at 12px each** — text over text, exactly the owner's
screenshot. Two fixes, both structural: `.extv-scroll-x > * { flex: none; }` (a scroller's
children keep their natural size — that is what scrolling means) and the width ROLES
`w-xs/sm/md/lg` (140/196/248/320px — the role crosses the contract, the number lives only
in the sheet). Re-measured in the same harness after: 4 columns of 248px, zero overlap,
zero text spill, the page never scrolling sideways (`tools/smoke-ui.js`,
`ext-kanban-mede-as-colunas`).

**What the round added to the contract — every piece identical for a manifest view and an
MCP-served one, because both cross the same `validate()`/`render()` pair:**

- `w` (width role) and `surface: true` on `stack` (a card with no colour of its own:
  `--paper` on `--panel`, both themes by construction);
- `surface.layout: "wide"` in the manifest — the screen takes the CONTENT COLUMN, never
  the window; the class comes off with the tab (measured: the manual opened after the
  board reads at ≤700px again);
- **`ask` on `button`** — the chat door, and it is the person's: the click opens Loro's
  own modal, the person writes, the sheet NAMES the habilidade it will run, and the send
  goes through `dispatchAiFromSheet` under the user's own `--permission-mode` (ADR-0021).
  `ask` and `action` are exclusive; the skill slug's alphabet is the guard
  (`RE_SKILL`, hyphenated, never a dot — CLAUDE.md §6); an extension cannot dispatch
  anything without the click and the sentence. Measured end-to-end in the smoke: the
  stub's `chat_send` received `/loro-kanban-move <ctx#id> em-pauta — decidir na reunião
  de quinta`, target and words intact;
- **`settings.<id>` bindings** — the HOST's effective copy (defaults overlaid by what the
  person saved) rides the `ext_view` payload into `ctx.settings`, for level 1 and level 2
  alike; a view `field` whose id is a DECLARED setting persists on change through the same
  `ext_settings_set` the Configurações sheet uses (merge per escopo), so the two screens
  cannot disagree — and one that is not declared stays transient, button input;
- `where` widened from one key to 1..=4 (an AND), and the `has` operator (case-folded
  substring; an EMPTY needle matches everything — an empty box is not a filter). Four is
  a ceiling, not a plan: past it a where is a query planner, and that belongs in facts.

**Where the status lives — the decision that makes the board a product.** A column is a
working state (`aberto · em-pauta · em-resolucao · concluido`, `KANBAN_STATUSES`, closed),
and the state lives in a DOCUMENT: `kanban/<context>/<id>/ponto.md`, front-matter
`status:`, versioned, reviewable, written by the `loro-kanban-move` habilidade the person
triggers — «an ordinary document, all the way down» (ADR-0029 §14). The facts walk counts
sibling `*.md` as comments by NAME only and reads exactly one line of one file
(`status:`, first 32 lines of `ponto.md`); a status outside the four **clamps to `aberto`
and never hides the card** — a board that silently drops a point is the worst failure a
board has. Moving to `concluido` also drafts the knowledge edit that closes the hotspot,
as a pending change for Revisão: the chat interaction the owner asked for — one that
*produces* something — is the extension driving the product's own doors, never a new one.

**What was seen red.** The two Rust facts tests failed with the derivation disabled
(`area` line removed → `null`; the counts line removed → assertion on 2), run on
2026-08-20; the seven new renderer tests and the multi-key `where` test were written and
run red before their implementations; and the two guards that tripped in the full suite —
the hook-scanner (`ganchos` list) and the err-translation sweep — tripped exactly as
designed, each demanding its wirer/translation by name.

**Post-round corrections (same day).** The owner's screen showed painted refusals: the
view asked for `settings.filtro` and the RECORD of an earlier install did not declare it —
the install record carries the schema of its own moment, so a pacote updated on disk
drifts from it until reinstalled (reinstall replaces the record whole, `install_at`'s
retain+push). Two things came out of it: a repo-level guard (`extview.test.js` reads the
SHIPPED example's view and manifest and fails if any `settings.*` ref is undeclared, then
renders the whole board with the manifest's own defaults and demands zero refusals), and
the owner's UX correction — the free-text search became a **dropdown born from the facts**
(`field.optionsFrom: {of, value, label}` + `empty`, options capped at 24, XOR with static
`options`), filtering the column `each` on `area has settings.filtro`. And one suite
defect found by running it repeatedly: env vars are process-global, but `ext.rs` and
`presets.rs` each held a PRIVATE `ENV_LOCK` while `chat.rs` and `lib.rs` held none —
`chat::the_agent_is_found…` failed 1 run in 3 under a parallel `with_home`. One crate-wide
`proc::TEST_ENV_LOCK` now serializes all four modules; 14 consecutive green runs after
(8 × `cargo test`, 6 × `make test`).

**«Ainda não está funcionando e nem mostrando» — the diagnosis chain (2026-08-20).**
Measured on the owner's machine, in order: (1) three app processes coexisted — a `tauri
dev` from 06:55, the installed release Loro.app v0.13.1 (which has no extensions at all),
and a debug binary relaunched at 09:56 — so the window being looked at rarely carried the
code being written; (2) the acervo's install record (`turbo/.loro/ext.json`) said
`settings: []`, `layout: None` — installed before the manifest grew either, so every
`settings.*` binding painted a refusal and the board never went wide (fixed by
`live_schema`: view AND schema now come from the same origin re-read, proven red→green
with the exact record state); (3) the EXTENSÕES sidebar section sits below ~80 knowledge
rows on the real acervo, and the post-install already opens the extension's tab — so the
person's one encounter with the screen was the refusals of (2), and afterwards the
section was "not showing" under the fold. What closed the round: the real-pipeline test
(`the_shipped_example_survives_the_real_view_pipeline` — installs the SHIPPED folder,
derives REAL facts, validates the REAL envelope, cross-checks every binding), because two
rounds had shipped green on a stubbed smoke while the real app painted refusals — a
harness that never runs the real half verifies itself, which is §7.1's oldest lesson.
