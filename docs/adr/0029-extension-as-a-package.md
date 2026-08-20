# ADR-0029 — Extension as a package: pacote, catálogo, and the loop as a kind

- **Status:** **accepted and implemented** (round 1 + the loop). The owner accepted
  the recommendations of §4 on 2026-08-17 and then **designed the screens** (Claude
  Design project *ADR-0029 Pacotes e Loops*, 2026-08-17), which settled §4.11–§4.14
  and changed three things this document had assumed — recorded in §13. §3 carries
  the invariants, the state contract (§3.9), the edge cases (§3.10) and what Claude
  Code's own loop teaches (§3.11). §14 records what the implementation itself
  taught, including the defects an adversarial review of it found.
- **Date:** 2026-08-17
- **Extends:** ADR-0003 (usage templates / per-acervo agent), ADR-0005 §2 (habilidades
  are `.claude/commands/*.md`), ADR-0018 (the analysis IS the meeting's output),
  ADR-0020 (one UI anatomy), ADR-0021 (the chat runs the acervo's own agent CLI in print
  mode, with an explicit `--permission-mode`), ADR-0022 §19/§22/§28 (a pause that really
  pauses · Configurações as one scrolling page · the freeze class of a sync command on
  the main thread), ADR-0024 (intake triage — the acervo's door is one-way), ADR-0027
  (review inside the app)
- **Answers:** the open point of hotspot **H-6** in `brain/contexts/loro/context.md` —
  *"whether habilidades should be shareable/exportable between acervos or teammates"* —
  and closes H-2's pending "vertical skill catalog"
- **Origin — two owner observations on 2026-08-17:**

  > O harness do DeepSeek vem com uma ideia que tudo é um plugin. Isso é interessante de
  > aplicarmos dentro do Loro. Imagino as pessoas construindo plugins e add ao Loro,
  > assim como funcionalidades. […] Há empresas já trabalhando com marketplace.

  > Usuários poderão criar **loops** para executar de tempos em tempos com a IA. Esse
  > loop produzirá artefatos, ou qualquer outra coisa que for setada, e será armazenado
  > numa pasta na lateral da árvore. O usuário poderá setar o loop, configurar,
  > visualizar o que foi produzido e enriquecer esse loop com comandos a partir de
  > prompt. Tal como funciona o loop do Claude Code, mas com uma UI e um local de
  > armazenamento. Esses loops poderão gerar contextos, ou então produzir novas ideias.
  > Poderão acontecer **no nível das ideias** ou **no nível geral** — isso é decisão do
  > usuário. E poderão servir como **plugin**.

  They are one ADR because they are **one tension seen twice** (§2.5): both are about
  work reaching the acervo without a person present at that instant, and both are
  answered by the same frame — an explicit act by the user, a visible state, power that
  only adds, and the doors that already exist.

---

## 1 · In plain words

*This section is for a reader who does not work on the codebase. Everything after it is
technical.*

### What Loro can already be taught

Three things in Loro are customizable today, and none of them can be handed to another
person:

- a **habilidade** — a text file that teaches the AI one task ("analise esta reunião",
  "traga esta nota do Drive"). Written in plain Portuguese, not in code.
- a **template de uso** — the starting shape of a new project (which knowledge topics
  exist, how the AI should read the queue). Loro ships seven: vendas, engenharia,
  produto, aprendizado, educação, recrutamento, saúde.
- the **AI agent** itself — which command-line assistant the project uses.

If someone writes three excellent habilidades for the legal team, the only way to share
them today is to send the files over chat and ask each colleague to drop them in the
right folder by hand. A template only exists on the machine that made it. And Loro's
seven templates are welded into the app: an eighth requires releasing a new Loro.

### What a pacote and a catálogo are

A **pacote** is one folder carrying any of those things together, with a small card on
top saying who made it, what it is and which version it is. You hand that folder to
someone, they install it, and the habilidades appear in their sidebar.

A **catálogo** is a list of pacotes published as an ordinary code repository. No server,
no store, no account. A team keeps its catálogo in a private repository and everyone
installs from it with the credential they already use for work. This is exactly how the
equivalent feature in Claude Code works, and Loro will speak that format instead of
inventing one (§2.2).

### The one distinction that governs everything

Two very different things can travel inside a pacote:

- **instructions** — text the AI reads and interprets. Harmless the way a recipe is
  harmless: it can be wrong, it cannot act by itself.
- **programs** — commands that actually run on the machine when certain things happen.

The second kind is what an extension store normally sells, and it is why stores need
curation, signatures and reputation. Loro records what people say, keeps it on their own
machine, and pushes approved knowledge to a shared repository under the user's own name.
A program arriving from outside and running inside *that* is a different risk from a
program running inside a text editor.

So: **a pacote is instructions by default.** Loro installs the instruction kind freely,
recognizes the program kind by name, refuses it until a later round, and never lets a
pacote loosen a protection Loro already promises (§3.3). And because installing writes
files into a project whose whole point is that nothing becomes official without review,
an install is **a change like any other**: checked at the door, visible in Revisão,
approved the way knowledge is approved (§3.4).

### The loop — the first genuinely new kind

Today every piece of AI work in Loro starts with a click. Nothing happens while you are
not looking.

A **loop** is standing work: you write once what you want done — *"leia as ideias desta
semana e escreva o que ainda não foi decidido"* — say how often, and the app runs it with
the AI on that rhythm. What comes out is a file, in a folder you can see in the left
tree, that you open and read like any other document. You can see what it produced last
Tuesday, correct it by talking to it (*"a partir de agora ignore as reuniões
canceladas"*), pause it, or turn it off. And a loop can travel inside a pacote, so a
team can share standing work the same way it shares habilidades.

Three things make that harder than it sounds, and they are why this document exists
before any screen:

1. **Loro's promise is that nothing leaves your machine unless you ask.** A clock that
   starts the AI while you are asleep is a different promise, and changing a promise is
   the owner's decision, not a design detail (§4.6).
2. **Loro's other promise is that no knowledge becomes official without review.** A loop
   writing straight into official knowledge would go around the step the product is
   built on (§4.7).
3. **A loop is easy to arm and easy to forget.** It spends the AI's quota on a rhythm,
   and after a few corrections nobody remembers what it was told to do. The design has
   to keep a loop *readable*, not just runnable (§9.6).

### Does the app look different?

A little, and nowhere new: one entry in a menu that already exists, one section in
Configurações, one sheet, and a mark on the habilidades that came from a pacote. The
loop needs a place in the left tree, and where exactly is an open decision. No store
front, no browsable grid of extensions with pictures. §5 has the detail.

---

## 2 · Context

### 2.1 Three extension surfaces already exist, each with its own shape

| Surface | Where it lives | What it can do | What it cannot do |
|---|---|---|---|
| **habilidade** (ADR-0005 §2) | `<acervo>/.claude/commands/*.md`; filename *is* the slash-command; 11 built-ins editable-never-deletable; custom ones via `/loro-tool` or `brain_new_tool` | teach the agent a task, declare its own `description:` / `argument-hint:` (which are UI copy) | be moved to another acervo or given to a colleague, except by hand |
| **template de uso** (ADR-0003) | built-ins embedded with `include_str!` (`presets.rs:53` onwards); custom ones as plain files in `~/.loro/templates/<slug>/`, same layout, and a custom id **shadows** a builtin | seed contexts, append to `AGENTS.md`, seed `inbox/_prompt.md`, carry a `context.md` mold, add skills | ship without a Loro release (for the built-ins); be published, versioned or updated |
| **agent** (ADR-0003) | per-acervo command, `brain_set_agent` | swap the whole inference engine | — |

Two facts follow, and they are the technical motivation for this ADR.

**The unit already exists; only the wrapper is missing.** A template directory is
already a manifest (`template.json`) plus content files, in two languages, resolved from
disk, with override-by-id semantics. A habilidade is already a single self-describing
markdown file. Nothing about the *content* has to change — what is missing is an
envelope, an install path and a way to move it.

**The built-ins are welded to the release cycle.** `presets.rs` embeds seven verticals
via `include_str!`. That was the right call for a self-contained binary and it stays
(§3.6) — but it means a vertical Loro does not ship cannot exist until Loro ships it.
That is the cost the "everything is a plugin" framing removes.

### 2.2 The format does not need to be invented

The default agent of an acervo is `claude` (ADR-0003), and Claude Code already has a
plugin and marketplace format. Verified 2026-08-17:

- A **plugin** is a directory with a manifest at `.claude-plugin/plugin.json` (`name`,
  `description`, `version`, `author`, plus optional `homepage`, `repository`,
  `license`). At the plugin **root** — never inside `.claude-plugin/` — it may carry
  `skills/<name>/SKILL.md`, `commands/*.md` (the older flat form), `agents/`,
  `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors/monitors.json`, `bin/` (added
  to the Bash tool's `PATH` while enabled) and `settings.json`.
- A **marketplace** is a `.claude-plugin/marketplace.json` in a git repository, added
  with `/plugin marketplace add owner/repo`. Each entry names a plugin and a `source`:
  a relative path, `github`, `git-subdir`, `url`, `npm`, `archive` or `command`. Git
  plugin sources take `ref` **and** `sha`; marketplace sources take `ref` only.
- **Private repositories work with the ambient credential** — the same git credential
  helpers / `gh auth` the terminal already uses. No token is issued or stored, which is
  BR-9 by construction.
- Anthropic runs two public ones (`claude-plugins-official`, curated;
  `claude-community`, reviewed submissions pinned to a commit SHA). A team can register
  its own for a repo via `extraKnownMarketplaces` in `.claude/settings.json`.

Sources: <https://code.claude.com/docs/en/plugins> ·
<https://code.claude.com/docs/en/plugin-marketplaces>

**The load-bearing coincidence:** a Loro habilidade is `.claude/commands/<name>.md`, and
a plugin's flat skill directory is `commands/<name>.md`. The same bytes, one directory
level apart. Loro's extension unit is already a Claude Code plugin that nobody wrapped.

### 2.3 Why the risk is not the same as in the CLI

A plugin carrying `hooks/`, `.mcp.json`, `bin/` or `monitors/` executes. In the bare CLI
the person who installed it is sitting in front of the terminal it runs in. Inside Loro
the chain is longer and mostly automatic:

```
pacote (outside content)
  → agent CLI that Loro spawns, with --permission-mode possibly bypassPermissions (ADR-0021)
  → an acervo directory that holds meeting transcripts
  → git add -A on «salvar versão» (minus the ADR-0009/0013 quarantine)
  → push, when the draft already carries an open review (ADR-0027)
  → main, on approval
```

Loro closes the loop from third-party content to a shared remote, signed with the user's
own git identity. Also `settings.json` in a plugin can set `agent`, which activates one
of the plugin's own agents as the **main thread** — a pacote could repoint the loop's
system prompt. And an instruction file is read by a model: the rule that content is data
and not commands has to be enforced by the design, not hoped for.

### 2.4 What the loop can reuse — and the one thing that does not exist

| Need | What already does it |
|---|---|
| run the AI without a terminal | `chat_send` runs the acervo's own agent CLI non-interactively (`-p --output-format stream-json`), streaming `chat-delta` / `chat-tool` / `chat-tool-result` / `chat-done`; `chat_status` reports `{running, hasSession, agent}`; `chat_cancel` kills the turn (ADR-0021) |
| the unit of instruction | a **habilidade**. A loop should *cite* one rather than carry a duplicate prompt |
| read what was produced | any markdown opens in the 700px card, with annotations (ADR-0007), the habilidades rail, the version seal — a loop artifact is an ordinary document, and no new viewer is built |
| a folder in the tree | a sidebar section is a caret + `＋` + count, rows with a per-row `⋯`, plus one button in the collapsed rail (`data-mini=…`, `index.html` ~222) |
| the door into the acervo | content triage (ADR-0024) and the review of pending changes (ADR-0027) |
| where working material lives | `brainstorming/<slug>/` (non-versioned) vs `contexts/` (versioned, official). Founding rule: ephemeral sources are unversioned; only approved content is source of truth |

**There is no scheduler.** Every clock in the app today is a frontend `setInterval` —
`brainPoll` at 10s (`app.js:2366`), the meeting tail, the elapsed timer,
`paintRecordingChrome`. The backend has no timer of its own: the only `Duration`s in
`src-tauri/src/` are a cache age, a launch grace window and test waits. So a loop that
runs **while the window is open** costs a frontend clock, a stored definition and the
existing `chat_send`; a loop that fires **with the app closed** is new infrastructure in
the Rust core (persisted next-run times, catch-up on wake, the tray keeping the process
alive). Those are different products with different promises — §4.6.

**One agent session, two owners.** There is one running turn at a time, resumed by
session id (`--resume`, `chat_reset`). A loop firing mid-conversation collides with the
person: for the process, for the session, and for the panel that shows a turn running
(§4.10).

**The word "loop" is already taken.** `/loro-context` is *the loop* throughout
`CLAUDE.md`, `ARCHITECTURE.md` §5 ("Brain loop") and the brain's own source of truth.
A second, unrelated "loop" makes every existing sentence ambiguous — §4.14.

### 2.5 One tension, seen twice

A pacote is content from outside reaching an agent that can write to a versioned acervo.
A loop is work starting without anyone present at that instant. Both remove the human
from the moment of action, and both are answered by the same four moves, which is why
they share an ADR instead of contradicting each other in two:

1. **an explicit act by the user** — installing, arming — never implied by the artifact;
2. **a visible state** the backend actually enforces;
3. **power that only adds** — no extension weakens a guarantee;
4. **the doors that already exist** — triage at the entrance, review before official.

A loop shipped inside a pacote combines both risks, which is why "a pacote may *suggest*
a loop; arming is always the user's act" falls out of the frame rather than being an
ad-hoc rule (§3.8).

---

## 3 · Decision — the frame

### §1 The unit: a pacote **is** a Claude Code plugin, plus `loro.json`

```
<pacote-id>/
  .claude-plugin/plugin.json   # the ecosystem manifest — name, description, version, author
  loro.json                    # the Loro half (below). Inert for Claude Code: it reads only what it knows
  commands/*.md                # habilidades (flat form — what Loro already writes)
  skills/<n>/SKILL.md          # habilidades (nested form — accepted, normalized on install)
  loops/*.md                   # loop definitions (§3.8), disarmed
  README.md
  # program kinds, recognized and refused in round 1 (§3.2):
  hooks/hooks.json  .mcp.json  .lsp.json  monitors/monitors.json  bin/  settings.json  agents/
```

`loro.json` carries what is Loro's and has no place in the ecosystem manifest:

```json
{
  "loro": 1,
  "kinds": ["skills", "seed", "loops"],
  "lang": ["pt", "en"],
  "seed": {
    "contexts": ["juridico", "juridico/contratos"],
    "agentsExtra": "pt/AGENTS.md",
    "inboxPrompt": "pt/_prompt.md",
    "contextMold": "pt/context.md"
  },
  "triage": { "warn": [{ "rule": "oab", "pattern": "…", "why": "…" }] }
}
```

The `seed` names are the fields `presets.rs::TemplateContent` already has
(`agents_extra`, `inbox_prompt`, `context_md`, `skills`). A pacote of `kinds: ["seed"]`
**is** a usage template, so `brain_list_templates` gains a source, not a second concept.

**Vocabulary** (DESIGN.md §4 — internal terms survive in code, IPC and on disk):

| Internal | UI |
|---|---|
| plugin | **pacote** |
| marketplace | **catálogo** |
| install | **instalar** |
| the pacote a habilidade came from | **origem** |
| a recurring unit of AI work | **rotina** — §4.14, recommended (`loop` is taken) |

### §2 Two classes, and the class decides which door

| Class | Contents | Round 1 |
|---|---|---|
| **declarative** | `commands/`, `skills/`, `loops/`, `loro.json` (`seed`, `triage.warn`), `README.md` | installs |
| **executable** | `hooks/`, `.mcp.json`, `.lsp.json`, `monitors/`, `bin/`, `settings.json`, `agents/` | **refused by name** — `err.plugin_kind_unsupported:<kind>` |

Classification is a **pure function of the directory listing**, not of the manifest's
claim: a pacote declaring `kinds: ["skills"]` and shipping a `hooks/hooks.json` is
executable. A manifest is an assertion by the author; the tree is the fact. (Same
reasoning as ADR-0024: `is_queueable` judged by file name and a transcript walked in.)

Refusing first and opening the door later is deliberate. The alternative — allow with a
warning — asks a person to audit a hook script inside an install sheet, which nobody
does twice.

### §3 An extension cannot weaken a guarantee — enforced in the backend

Additive only, and asymmetric on purpose (the shape ADR-0024 already uses: a credential
blocks, everything else warns):

- it **may add** `warn` triage rules;
- it **may not** remove or relax anything: the `intake.secret` **block**, the
  `is_queueable` BR-8 refusals, the path guards, the `git::GIT_IGNORED` quarantine, the
  capture path, or any git/`gh` write;
- it **never grants itself permission.** `--permission-mode` stays the user's choice
  (ADR-0021); no manifest field, and no loop definition, is read as a permission;
- its `AGENTS.md` contribution is **appended, never substituted** — the rule
  `presets.rs` already states for `agents_extra`, because the default `AGENTS.md`
  carries the loop mechanics the whole model depends on;
- **instructions are data.** They are never executed by the app — the posture already
  written at `presets.rs:1-9` for template content, now binding for a wider class of
  input.

Checked where the write happens, independently of what the UI asked: "a gate that trusts
the frontend to have asked is not a gate" (ADR-0024).

### §4 Installing is a change, and it uses the doors that exist

1. **Preview, read-only.** `brain_plugin_manifest(source)` reads the manifest and lists
   the tree: what it brings, its class, its version, its origin. Nothing is written.
2. **Triage at the door.** Every file the pacote would write goes through
   `brain_triage_files` (ADR-0024). A vendor-prefixed credential **blocks**
   (`err.intake_secret:<file>` — names the file and the rule, never the finding, BR-8).
   A CPF or a pasted transcript warns and the person decides.
3. **The write lands as a pending change.** To the working tree, not to a commit:
   `brain_git_state` / `brain_git_diff` already see it, so it appears in *Mudanças de
   agora* as ordinary `.revcard`s (ADR-0027), and a team reviews a pacote exactly as it
   reviews knowledge. The install commits nothing and pushes nothing.
4. **The install is recorded.** `.loro/plugins.json` (per-acervo, versioned like
   `.loro/settings.json`, because it is the project's policy and travels with it):

   ```json
   [{ "id": "juridico-br", "version": "1.2.0",
      "source": { "kind": "github", "repo": "org/loro-plugins", "sha": "…" },
      "kinds": ["skills","seed","loops"], "installedAt": "2026-08-17",
      "files": [{ "rel": ".claude/commands/loro-parecer.md", "sha256": "…" }] }]
   ```

   The per-file `sha256` is what makes §5 possible; the pinned `sha` answers "which
   version of the pacote wrote this", an audit question on a versioned acervo.

### §5 Uninstall subtracts what it added, never what the person wrote

`brain_remove_plugin(id)` removes the recorded files **whose hash still matches**. A file
edited after install is left on disk and reported back, so the screen can say so. This is
the non-destructive premise (`brain/contexts/loro/context.md`, "Core premises") applied
to the one operation that would otherwise delete a colleague's edits.

### §6 Distribution: a repo is the catálogo; the binary keeps its offline floor

- A catálogo is `.claude-plugin/marketplace.json` in a git repository. Loro clones with
  the **ambient credential** (BR-9), so a private repository is a team's internal
  catálogo — the Turbi case — with nothing new to authenticate.
- Sources supported, by round: a local directory (R1), then `owner/repo` and a git URL
  with `ref`/`sha` (R3). `npm`, `archive`, `command` and `url` are **not** supported:
  three of them fetch code and the fourth cannot resolve relative plugin paths. An
  unsupported source fails by name (`err.plugin_source_unsupported`), never silently.
- **The seven built-in verticals stay embedded.** First run must work with no network —
  this is a local-first product and the model download is already the one thing that
  needs the network (ADR-0006). The catálogo *adds*; it does not replace the offline
  baseline. A pacote whose id equals a builtin's **shadows** it, the rule `presets.rs`
  already implements for `~/.loro/templates`.
- Loro publishes its own catálogo (`aipi/loro-plugins`, the neighbourhood of the cask tap
  of ADR-0006). Whether it exists at launch is §4.13.

### §7 The declarative core is agent-agnostic; the executable half is not

The acervo's agent may be any CLI (ADR-0003), and for a non-Claude agent Loro already
injects habilidades as plain prompts. So `commands/`, `skills/`, `loops/` and every
`loro.json` field work for any agent. `hooks/`, `.mcp.json`, `bin/` and `monitors/` are
Claude Code's. When a pacote carries them and the acervo's agent is something else, Loro
says so in the copy — an inert install that looks successful is the interface knowing
something it does not say (DESIGN.md §1).

### §8 A loop is the fourth kind, and these are its invariants

A **loop** is a declarative definition — an instruction (usually a habilidade it cites),
a rhythm, a destination, a scope — with a *scheduled effect*. Whatever §4.11–§4.14 settle,
the following hold, because they are §3's frame applied to a loop:

1. **Arming is the user's act.** A loop arrives from a pacote **disarmed**, always. A
   third-party plugin scheduling AI work on someone's acervo is the one thing the whole
   class distinction of §2 exists to prevent.
2. **BR-8 binds the history.** A cycle's record carries structure — when, how long, which
   files, the outcome, an `err.*` code — and **never** the text produced or a quote from
   a transcript. A history that logs the output has put the acervo's content in a log.
3. **A loop is not a privileged writer.** What it writes passes the triage and shows up
   in the review, exactly like what a person writes (§3.4).
4. **A loop never grants itself permission** (§3.3). What mode an *unattended* run uses
   is §4.9, and it is the user's stated choice.
5. **The artifact is an ordinary document** (§2.4) — same 700px card, annotations, move,
   delete, send to the fila.
6. **A loop never writes official knowledge on its own.** §4.7 put the artifact in the
   non-versioned world, and the path from there to `contexts/` keeps its human decision
   and its review.
7. **State must never lie** (DESIGN.md §1). If the screen says it runs every 30 minutes,
   it runs every 30 minutes; if it cannot run now, it says so — the same rule that made
   pausing a meeting really stop the capture (ADR-0022 §19).
8. **A cycle never runs commands.** `--disallowedTools Bash` on every cycle, always
   (`NEVER_FOR_A_CYCLE`). This invariant used to be a sentence in the prompt, and the
   session log showed a cycle listing a directory outside the project under `acceptEdits`:
   the mode auto-approves Bash. «No git, no version, no send» (§3.8) and «read and edit the
   project» are only true because of that flag. Scoped execution (`Bash(git *)`) is §4.3's
   door and needs its own decision.
9. **Off the main thread** (ADR-0022 §28) for every backend call it makes.
10. **A pointed scope is a boundary, not a hint** (§4.15). A loop pointed at a folder
   or a context is told to read *only* that. Widening a scope in silence — because a
   shape was unrecognized, because a `..` was quietly dropped — is the one mistake
   this field must not make: it is refused instead (`err.loop_scope_invalid`).
11. **Nothing a cycle may touch outside the project is granted by anyone but the person**
    (§4.18). Not by a pacote, not by a default, not by a habilidade it cites. The grant is
    the PROJECT's, given in answer to a request that names the tool, and «tudo, sem
    perguntar» is refused for a cycle in every spelling, including a bare `*`. A pacote
    has no path to it: install destinations are built by Loro, so `.loro/settings.json`
    cannot be written from a package — the guard is structural, not a check.
12. **A loop stays readable.** After five enrichments a person must still be able to see
   what it was told to do. A loop nobody can read is a black box, and that is a design
   failure even when every cycle succeeds (§9.6).

---

### §9 A loop's state is a fact the app states — and "armed" is not "able to run"

The question every scheduler answers badly: *is it going to run, and is it running now?*
A loop has **eight** states, and the eighth is the one that is usually missing.

| Internal | UI (pt-BR / en) | What it means | Carries |
|---|---|---|---|
| `off` | **desarmada** / off | exists, does nothing | — |
| `armed` | **armada** / armed | will run | **próxima execução** (when) |
| `running` | **rodando** / running | a cycle is running now | what it is doing, from the existing `chat-tool` stream |
| `queued` | **esperando você terminar** / waiting for you | armed, its turn came, the person is using the agent | position, and what it is waiting for |
| `blocked` | **impedida** / blocked | armed and **cannot** run | the reason, and the door to fix it |
| `paused` | **pausada** / paused | the user stopped it | since when |
| `failing` | **falhando** / failing | N consecutive failures, backing off | the count, the last `err.*`, the next attempt |
| `expired` | **expirou** / expired | ran its life out (§3.10 F2) | when, and how to re-arm |

**`blocked` is the load-bearing one.** *Armed* and *able to run* are different facts, and
the standard failure of a scheduler is to report the first while the second is false. A
loop is blocked, each with its own sentence and its own door, when: no agent is configured
or the agent binary is gone (→ Configurações → IA e terminal) · the project is not the
active one · its scope no longer exists (the idea was deleted or moved) · the habilidade
it cites no longer exists · a permission decision is pending (§3.10 C4) · a write ceiling
was reached · another window holds the acervo's lock. Painting *armada* over any of those
is the interface knowing something it does not say (DESIGN.md §1).

**Three distances, because the answer is needed at three of them.**

1. **The row**, where the loop lives in the tree: the state as a mark plus the next run in
   mono. Existing semantics, no new token — amber when it needs the person (`blocked`,
   `failing`), teal while `running`, `--ink3` when `off`.
2. **From any screen**, while a cycle is actually running. The app already solves exactly
   this for recording: a header pill and the tray parrot blinking (ADR-0022 §21). Work
   happening unattended is the same class of fact and must be visible without opening
   anything — but it is **not** red: red is recording and irreversible, and this is teal
   (AI). It also must not blink like the parrot; one mark, one meaning.
3. **The loop's own screen**: the *effective* instruction, last run, next run, the last
   cycles with their outcome, and the enrichment log.

**One authority.** `loop_status` is the single source the row, the header mark and the
screen all read — the discipline `pending_entries` already has in ADR-0027, where one
reader keeps the tab count, the cards and the refusals from disagreeing. And a state the
backend does not enforce is never painted (§3.8.7).

### §10 Edge cases, each with its rule

**A · Concurrency and the single agent session**

1. **A cycle is still running when the next tick arrives.** Never two cycles of one loop
   at once: the tick is **skipped**, and a skipped tick is recorded as skipped — not as a
   failure, and not as silence.
2. **The person is using the agent.** The loop goes `queued` behind the live turn (§4.10)
   and says so. It never cancels a human turn.
3. **Two loops want the same minute.** Cycles are serialized per acervo and **staggered**,
   so two rhythms that share a divisor do not collide forever; the queue shows position.
4. **Two windows, one acervo.** A lock in `.loro/` decides; the loser is `blocked` with
   *outra janela está rodando esta rotina*, never a duplicate cycle.
5. **The app quits mid-cycle.** The cycle ends as *interrompida*; a half-written artifact
   is either completed or removed, never left as a truncated document with no marker.

**B · Time**

1. **The app was closed.** With §4.6 = (a) the loop does not run — and the screen says
   *não rodou: o app estava fechado*, with the windows it missed counted. A `próxima
   execução` in the past is a lie.
2. **No catch-up storm.** On reopening, at most **one** immediate run, and only if the loop
   says so; the default is to skip the missed windows and state them.
3. **The machine slept.** The rhythm is computed from wall-clock time since the last run,
   never from a tick count, so a lid closed for six hours does not fire six cycles.
4. **DST and clock jumps.** Rhythms under a day are **durations** since the last run
   (immune to the offset change); a daily rhythm is local wall-clock and states the one
   day that has 23 or 25 hours. This is the hazard cron-in-local-time inherits (§3.11).
5. **A rhythm faster than a cycle.** A 5-minute loop whose cycle takes 8 minutes: the
   floor is *the last cycle's duration*, and the screen says the rhythm was widened
   instead of quietly skipping every other tick.

**C · The environment**

1. **The agent is gone or changed** (`brain_set_agent`, or the binary left `PATH`) →
   `blocked`, naming it, with the door to Configurações.
2. **The agent fails** (no network, its own API error). The cycle's outcome is the failure
   with an `err.*` code; consecutive failures **back off exponentially** and the loop
   **stops after K** and says so. A loop that retries forever is a silent bill.
3. **BR-9 holds through failure.** Nothing the agent prints on failure is logged beyond a
   code and counts.
4. **A permission decision is pending.** Print mode cannot ask (ADR-0021), and the
   existing denial detection offers *liberar tudo e repetir* — which is **never**
   auto-answered for an unattended cycle. The cycle ends *impedida por permissão*, the
   loop stays armed, and the state turns amber: it needs a person.
5. **The project is not the active one.** A loop runs only for the open project;
   otherwise it is `blocked` for that reason, not silently idle.

**D · The work itself**

1. **A quiet cycle.** Producing nothing is a legitimate outcome (*nada novo*) and it is
   recorded; **consecutive** quiet cycles collapse into one row with a count, so the
   history never becomes the activity feed ADR-0020 §4 removed.
2. **A runaway cycle.** Ceilings, stated at arming: files per cycle, total files per loop,
   cycles per day. Hitting one **stops** the loop and names the ceiling that stopped it.
3. **A loop that feeds itself.** Its destination is **excluded from its own reading scope**
   by default: a loop that reads the folder it writes to grows its own input every cycle
   until the run is enormous and the output is a summary of its own summaries.
   Accumulation is possible, but only as an explicit choice.
4. **A loop that repeats itself.** Writing the same conclusion every cycle is the failure
   mode of standing work; the artifact convention (§9.5) must make "this cycle changed
   nothing" cheap to see — that is what D1 is for.
5. **A loop may not perform a person's acts.** No `git` write, no version, no send for
   review, no outbound message: those stay explicit human actions (§11).

**E · The material**

1. **The triage blocks what a cycle wrote.** The credential rule applies to generated
   material exactly as at the fila's door (ADR-0024): the file does not enter, the cycle's
   outcome says which rule, and the state needs a person. **BR-9 is not relaxed for a
   machine writer.**
2. **BR-8 through the history.** A cycle record carries when, how long, which files, the
   outcome and an `err.*` code. Never the produced text, never a quote.
3. **Its target disappeared.** The idea was deleted, or the meeting was moved
   (`brain_move_meeting`) → `blocked` naming it, never a write into a path that was
   rebuilt by hand.
4. **The habilidade it cites changed.** Editing it changes the loop's behaviour without the
   loop changing, which is why the loop's screen names the habilidade it cites — the change
   stays legible. Deleting it is `blocked`.

**F · Lifecycle**

1. **Enrichment mid-cycle** takes effect on the **next** cycle, and the screen says which
   cycle will be the first to use it.
2. **A loop expires.** An armed loop has a life (default measured in days, stated at
   arming): it fires one last time, turns itself `off`, and says *expirou*. Standing work
   nobody looks at is the most expensive kind.
3. **Removing a pacote that brought a loop.** An enriched definition is an edited file, so
   §3.5 keeps it and reports it; a **running** cycle is cancelled first, never orphaned.
4. **Deleting a loop** does not delete what it produced: the artifacts are documents and
   they stay, with the loop named in their front matter so their origin survives their
   producer.

### §11 What Claude Code's own loop teaches, and where it stops short

Studied on 2026-08-17, in the tooling of this very session — two mechanisms:

- **self-paced**: after each turn the model schedules its own next wake-up. The delay is
  clamped to **[60, 3600] s**; it carries a one-line **`reason`** that is shown back to the
  user; a **`noop`** flag marks a tick where nothing happened, and consecutive noop ticks
  are **collapsed into a streak** in the user's view; the loop can **stop itself**.
- **fixed interval**: a 5-field cron in **local time**; jobs fire **only while the REPL is
  idle, never mid-query**; a deterministic **jitter** spreads load (recurring jobs fire up
  to 10% of their period late, capped at 15 min); recurring jobs **auto-expire after 7
  days**, firing one final time; jobs are **session-only** — nothing on disk, gone when the
  session exits; and the guidance steers you away from cron for *watching* state, because
  polling is the wrong shape for it.

**Adopted, and where:** idle-only firing → §3.10 A1/A2 · noop collapsing → §3.10 D1 · the
`reason` line, as *what it will do next and when, in words* → §3.9 distance 3 · expiry with
a final run → §3.10 F2 · jitter → §3.10 A3 · durations instead of wall-clock → §3.10 B3/B4 · "a
loop is for periodic work, not for watching" → the acervo already has its own change
signals, and a loop is not the way to watch a file.

**The gaps Loro must not inherit:**

1. **No `blocked` state.** "Armed" is the only word, so a loop that cannot fire looks
   exactly like one that will. §3.9 adds it, and it is the single most important addition.
2. **A skipped tick is invisible.** Loro records it (§3.10 A1).
3. **No persistence, and no statement of it.** A session-only job simply vanishes; Loro
   *says* the loop does not run while the app is closed and counts what it missed
   (§3.10 B1) — which is what makes decision §4.6 (a) honest instead of merely cheap.
4. **No cost accounting.** Nothing states what a rhythm will spend. Loro states the price
   at arming and enforces ceilings (§3.10 D2, §4.11).
5. **Local-time cron inherits DST.** §3.10 B4.
6. **No destination, no artifact, no reading scope** — this is Loro's own addition, and it
   brings the one hazard Claude Code never has to solve: **a loop whose output sits inside
   its own input** (§3.10 D3).

---

## 4 · Decisions

The owner accepted the recommendations on **2026-08-17**. What is decided is decided; what
is still open is still open, and a design that assumes one of the latter has assumed a
premise.

### Decided

| # | Decision | What was chosen |
|---|---|---|
| 4.1 | the UI word for the extension unit | **pacote** — short, natural pt-BR, no store connotation. `plugin` stays the internal identifier |
| 4.2 | where pacotes are managed | **Configurações**, as a new section of the one scrolling page (ADR-0022 §22) |
| 4.3 | the executable class | **refused by name in R1**; the door opens later, in its own ADR (R5) — **that ADR is ADR-0031, and its R5a is in the code.** It does not relax this door: `brain_install_plugin` still refuses an executable pacote by name, `EXECUTABLE_MARKERS` is untouched, and an extension installs through the SEPARATE `ext_install` door. One door per protocol; a v2 manifest handed to this one still refuses with `err.plugin_schema_unsupported`, and a v1 pacote handed to that one refuses with `err.ext_protocol_unsupported` |
| 4.4 | scope of an installed pacote | **versioned inside the acervo** — it is the project's policy and travels with the project |
| 4.5 | a catálogo of *knowledge* (filled contexts) | **not now** — recorded as a hotspot in H-6 for a future RFC. It is a different product: curation, content liability, LGPD |
| 4.6 | **BR-1 and the clock** | **armed once, runs only while the app is open.** A visible state says it is armed and what comes next. **No BR-1 amendment is needed** — the arming is the user's explicit act and the work only happens in front of a running app |
| 4.7 | where a cycle's artifact lands | **the non-versioned world** (a loop's own folder inside the idea's world), and from there **through the fila** like everything else. A loop produces *material*, never official knowledge |
| 4.8 | scope: ideias vs geral | **declared once at creation** — the scope is what the instruction assumes. Re-pointing is a new loop |
| 4.9 | permission mode for an unattended run | **`acceptEdits` only.** `bypassPermissions` is **refused by name** for a loop (`err.loop_permission_refused`), never offered with a warning |
| 4.10 | collision with the person's conversation | **queue behind the live turn**, with the state saying *esperando você terminar*. A loop never cancels a human turn |

### Decided by the design pass (2026-08-17)

| # | Decision | What the design chose |
|---|---|---|
| 4.11 | cost ceilings | **three brakes, as fields**: files per cycle (3), runs per day (8), an expiry date (30 days). A NEW loop is born with the project's defaults (Configurações → Loops) and may loosen or tighten its own. Hitting one **ends the cycle** and the loop's screen names which — «freios, não metas» is the copy |
| 4.12 | where a loop lives in the tree | **its own fifth section**, LOOPS, between CONHECIMENTO and HABILIDADES DE IA, separated by a hairline. A loop is not inside an idea because it can belong to the whole project — and it is **not** a destination in the nav pill |
| 4.13 | the official catálogo | **not in this round**: the install reads a local folder. Configurações → Plugins carries the row list and the ⋯ (ver o que trouxe / remover); the team marketplace is R3 |
| 4.14 | the name | **loop**, kept — the UI word and the internal identifier. The distillation loop is disambiguated in prose («o loop do `/loro-context`»), and *ciclo* is the word for ONE run of a loop |
| 4.15 | **what a loop works on** | the scope has **four shapes**: `projeto`, `ideia:<slug>`, `pasta:<rel>` and `conhecimento:<slug>`. A pointed scope (the last three) is **not a hint the agent may widen** — the cycle prompt says *«leia SOMENTE …»* — and the folder is **typed or picked** from the project's folders (`loop_folders`). It stays under §4.8: declared once, at creation. A pointed folder that no longer exists is **impedimento** (`err.loop_scope_missing:<rel>`), never a failure — five retries would spend the AI to learn what the filesystem already said |
| 4.18 | **what a cycle may use beyond the project** | **nothing is declared in advance; a grant is given when a cycle ASKS, and it is the PROJECT's.** The set of tools is unbounded and cannot be enumerated — «as permissões podem ser infinitas» — so the request is the mechanism, not the fallback: a refused cycle names the tool, the request waits in the ⟳ Loops panel, and one answer settles it for the next cycles of every loop («uma vez dado, o usuário concedeu»). It is **not a prompt**: nobody watches an unattended cycle, so nothing blocks waiting for an answer — the cycle ends, the question persists. Stored in `.loro/settings.json` (the project's loop policy) and passed as `--allowedTools`; it applies to **cycles only**, never widening what the Chat or the terminal may do. «Não» is a real answer: it goes to `--disallowedTools`, so a closed door is not «ask me again next cycle». The three refusals of 4.17 hold unchanged (`Bash` is not offerable, a bare wildcard is refused, and a pacote cannot grant — now because install destinations are built by Loro and `.loro/` is unreachable from a package) |
| 4.16 | **which model a cycle runs with** | **per loop**, and editable after creation: `modelo` + `esforco` in the definition, carrying the CLI's own values, empty meaning «whatever the agent already uses» (no flag is passed). A loop is a STANDING cost — a project-wide setting would make one loop's ceiling everybody's — so the field sits next to the rhythm and the brakes, and the loop's screen states it (*«roda com opus · muito alto»*). What reaches `argv` is re-checked at spawn time, not only on save: the definition is a document a hand or a pacote can rewrite |

| 4.17 | ~~what a loop may use beyond the project~~ | **Superseded by 4.18 the same day.** Kept for the record: a named list on the loop itself (`permite:` in its definition), with the list of what CAN be named **discovered from the project**, never a vocabulary of connectors written into Loro: the MCP servers `.mcp.json` declares (with the pacote that brought each, when one did) plus the agent's own outward tools. A connector nobody at Loro has heard of appears the day it is installed, with no release in between. Three refusals hold the line: **`Bash` is not offerable** (arbitrary execution is §4.3's door, and it does not open through a checkbox), **a bare wildcard is refused** (it would be §4.9's `bypassPermissions` under another spelling — only `mcp__<server>__*` is accepted), and **a pacote can never ship a grant** (the installer blanks `permite:` exactly as it blanks `ligado:`, §8.1). A refused cycle **names the tool it asked for** (`err.loop_permission_refused:<tool>`) and the screen offers the smallest possible act: *permitir neste loop* — never «liberar tudo e repetir», which is what the chat offers a person who is watching |

*(4.15, 4.16 and 4.17 were decided by the owner on **2026-08-18**, after using the loops
of R4: pointing a loop at a folder, choosing what a standing cycle costs, and — the
question that produced 4.17 — «o usuário pode abrir um loop para ler o Slack, ou o
Drive, ou qualquer outra coisa; onde fica a permissão?». Slack and Drive are examples:
since **everything is a pacote** and the person writes their own habilidades, what can
be permitted has to be discovered, not enumerated.)*

**A habilidade is not a permission.** The distinction 4.17 rests on: a habilidade is an
instruction the loop *cites*, and an instruction needs no grant — what needs one is the
**tool** it reaches for. A pacote that brings ten habilidades widens what a loop knows
how to do; only one that brings an MCP server widens what it can *touch*, and that
server still arrives permitted to nothing.

**The list is the project's, so it can be incomplete — and that is covered.** Discovery
reads the acervo's own `.mcp.json`, because a project's connectors are the project's
policy (§4.4). A server configured at the *agent's* user scope therefore does not appear
as a tick-box, even though a cycle could use it if named. This is not a hole: the second
path exists for exactly that case — the cycle asks, the denial **names the tool**, and the
screen offers to allow that one. What cannot be listed can still be granted, by the
person, in response to a real request rather than a guess.

**What this consciously does not fix.** Granting an MCP tool grants what that tool does,
and Loro cannot tell a connector's read from its write by name. The cycle prompt keeps
forbidding outbound acts, so «a loop never sends anything outward» (§3.8) is, for a
granted connector, a **prompt rule and not a mechanism** — the honest wording, since the
alternative is a deny-list of verbs that would quietly fail. Two consequences follow, and
both are stated on screen rather than hidden: the grant is written into the versioned
definition, so a teammate reads it in Revisão; and content a connector returns can carry
**third-party personal data** into a shared, versioned project — LGPD ground the intake
triage (ADR-0024) does not cover, because it screens credentials, not conversation.

### Still open

11. ~~**Cost ceilings.**~~ *Decided above.* The original recommendation, kept for the record: Recommendation, informed by §3.11: three ceilings stated at arming
    — files per cycle, total files per loop, cycles per day — plus the **expiry** of §3.10 F2,
    and the price named in the arming copy. What the *numbers* are is the owner's call.
12. ~~**Where the loop lives in the tree**~~ · 13. ~~**The official catálogo**~~ ·
    14. ~~**The name**~~ — *all three decided above.* On 14 the design KEPT "loop",
    against this document's own recommendation (*rotina*): the word in the sidebar is
    the word the ecosystem uses, and the two loops rarely share a sentence.

## 5 · Visual consequences

**Yes, but nothing new is invented.** No destination is added to the nav pill (anatomy
rule 2: destinations are fixed and cannot be dismissed), no second anatomy, no store
front.

### 5.1 The package — seven changes, each inside a pattern that exists

1. **The habilidade row gains its origin.** `toolRow` (`app.js:3785`) paints puzzle =
   built-in, star = custom, plus the `padrão` pill. A habilidade from a pacote takes a
   **third glyph** in the same `ico()` set, and its pill slot carries the **pacote's
   name** in mono — "where did this come from" is the question that matters the moment a
   habilidade misbehaves. One pill per row: `padrão` and origin never co-occur.
2. **One entry in a menu that exists.** The `＋` of *Habilidades de IA* (`#addToolBtn`)
   opens the same `.fitem2` list as today — *nova habilidade (IA)* · *importar habilidade
   existente* — and gains **＋ instalar pacote…**. Three entries, no submenu.
3. **Management goes in Configurações**, a new section of the one scrolling page
   (ADR-0022 §22 — the nav scrolls to a section and the scroll-spy tracks it, so a section
   is the native unit there). One row per pacote: name, version, origin in mono, what it
   brought (`3 habilidades · 2 conhecimentos · 1 rotina`), and a `⋯` with *atualizar* /
   *remover*. `remover` is a destructive confirmation, so it borrows the wider box
   (240–260px) and the path wraps (DESIGN.md §5).
4. **The install sheet is a sheet, with one primary action.** A folder field ("do
   computador"), later an `owner/repo` field; then, once the manifest is read, a **o que
   este pacote traz** block and the triage result when there is one. It obeys the sheet
   rules already written: the primary action goes disabled and reads `um momento…` while
   the work runs; failure **keeps the sheet** with the reason in the `role="alert"` slot
   and the fields as they were; success is the only outcome that closes it.
5. **The price is in the copy** (DESIGN.md §1). Declarative: *"as habilidades entram no
   projeto como uma mudança — você revê antes de virar oficial."* Executable, in round 1,
   is a refusal that names the reason: *"este pacote traz automações que rodam comandos no
   seu computador. O Loro ainda não instala esse tipo."* Not a generic failure — the class
   is the reason.
6. **The wizard gains no control.** A `kinds: ["seed"]` pacote appears in the template
   `<select>` (`#wizTemplates`) with its origin in `#wizTemplateHint` below it — the route
   custom templates already take. An executable pacote is **never** offered during project
   creation: somebody naming a new project is not auditing code.
7. **Revisão shows the install as what it is** — ordinary cards in *Mudanças de agora*.
   That is the point of §3.4, and it costs no new UI at all.

**No new colour token and no new state colour.** A pacote is a source, not a state; the
section it lives in is already teal (AI and knowledge). A hue for "comes from outside"
would claim a semantic the palette does not have.

### 5.2 The loop — the constraints, and what the design pass resolves

The loop needs five surfaces — **create · configure · observe · read · enrich** — and
where each one lives is §9.2's deliverable, bounded by: no new nav destination; the
sidebar's fifth-section cost (§4.12); the collapsed rail needs one button per section;
the artifact is read in the existing document card; the states use the existing semantics
(**amber** = pending / needs you · **teal** = AI and knowledge · **red** = recording and
irreversible) and no new token without arguing why an existing one is wrong; and a running
cycle reuses the panel that already shows a turn running rather than inventing a second
progress language.

**What must not appear** — one line for DESIGN.md §8: no store front, no browsable grid
of pacotes with artwork, ratings or "destaques"; no activity feed or dashboard for loops
(Home statistics and the activity feed were deliberately removed, ADR-0020 §4); no ⓘ
tooltip explaining what a pacote or a loop is; no new nav destination. Browsing a catálogo
is a **list of names with a description** — the 196px picker vocabulary the app already
uses for habilidades.

---

## 6 · IPC contract (implemented)

All `async` / `spawn_blocking`: reading a tree, hashing files, cloning a repository or
waiting on a cycle from the main thread is the freeze class of ADR-0022 §28, which
already has a test.

### Packages

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `brain_plugin_manifest` | `source` | `{id, name, description, version, author?, kinds[], class, brings{skills[],contexts[],loops[],files[]}, findings[]}` | read-only preview: manifest + tree + class + triage. Writes nothing |
| `brain_install_plugin` | `{source, ref?}` | `{id, version, written[]}` / err | copy the declarative parts into the acervo, record in `.loro/plugins.json`; refuses an executable class, a credential, a path escaping the pacote root, an id conflict. Loops arrive **disarmed** |
| `brain_list_plugins` | — | `[{id, name, version, source, kinds[], installedAt, brings}]` | what this acervo has installed |
| `brain_remove_plugin` | `id` | `{removed[], kept[]}` | subtract the unmodified files it added; `kept` names what was edited after install (§3.5) |
| `brain_export_plugin` | `{ids?, dest}` | dir | R2: turn this acervo's custom habilidades (and loops) into a pacote directory, manifest included |
| `brain_catalog_list` | `source` | `[{id, name, description, version, source}]` | R3: read a `.claude-plugin/marketplace.json`; 30s cache carrying the reading's age, like `gh_pr_list` |

### Loops — as implemented

`loop_status(now)` (the single authority — it also carries the running cycles' ages,
so a window reload does not lose «rodando · 2m40s») · `loop_tick(now)` (the clock's
question) · `loop_run_now(slug, now)` · `loop_stop(slug)` · `loop_save(input)` ·
`loop_arm(slug, on)` · `loop_enrich(slug, texto, hoje)` · `loop_delete(slug)` ·
`loop_policy` / `loop_set_policy` · `loop_folders` (the project's folders, three
levels deep, nothing hidden — what lets a scope be CHOSEN instead of typed, §4.15) ·
`loop_capabilities` (what THIS project can offer, discovered — §4.17/§4.18) ·
`loop_permit(tool, decision)` where decision is `permitir | recusar | esquecer` — the
project's decision about one tool; it clears the pending question on **every** loop that
asked it, and it does not run a cycle. `loop_status` grew `requests[]` (one entry per
TOOL, with the loops that stopped on it), `permite[]` and `recusa[]`. Events: `loop-cycle` (started/ended) and
`loop-tool` / `loop-tool-result`, which are the chat's OWN reader
(`chat.rs::handle_stream_line`, parameterized by channel) with the loop's slug
attached — one parser for both, and the chat's payload byte-identical.

`loop_history` was dropped: the history is part of `loop_status`'s answer, and a
second command would be a second reading of the same file (§3.9). `loop-state` was
dropped too — `loop-cycle` plus the tick already tell every surface when to repaint.

The full table, with args and returns, lives in `docs/ARCHITECTURE.md` §4.1.

New error codes (`err.<snake_key>`, translated by `tErr()`):
`err.plugin_manifest_invalid` · `err.plugin_kind_unsupported:<kind>` ·
`err.plugin_source_unsupported` · `err.plugin_id_conflict:<id>` ·
`err.plugin_path_escape` · `err.plugin_write_failed` · `err.loop_permission_refused` ·
`err.loop_agent_busy` · `err.loop_scope_missing:<rel>` · `err.loop_scope_invalid`
(§4.15) · `err.loop_tool_invalid` (§4.17). And one code gained a detail:
`err.loop_permission_refused:<tool>` — the tool the cycle asked for, so the screen can
offer to allow it. The name is read from **two** places, because the first one is not the
one that happens: a denial inside a `tool_result` carries only `tool_use_id`, matched to
the name announced earlier in the `assistant` block (`chat.rs::note_denial`) — but a real
refusal in print mode ends the **whole turn**, and there the tool's identity exists only
in the sentence «requested permissions to use X» (`chat.rs::tool_in_denial`). The first
implementation had only the id path, and the screen went on saying «faltou permissão»
with nothing to offer. Case is the discriminator: an agent tool is CamelCase or `mcp__…`,
while «permissions to write» is a verb.

The screen offers the button **only when the named tool is one a loop can be given**: a
refused `Bash` is named and explained, never offered, because `loop_allow` would refuse
it — an action that answers with an error is not an action (DESIGN.md §1).

**4.18 replaced the location of all of this, hours later, and the reason is the honest
one:** the owner asked «as permissões podem ser infinitas, não é melhor deixar que elas,
quando solicitadas pelo agente, apareçam aqui?» — and the answer is yes, because the
document already admitted it. §4.17's own limits paragraph said discovery reads only the
project's `.mcp.json`, and that what it cannot list is still granted through the refusal
path. If the refusal path covers the gap, **the refusal path is the mechanism**, and the
pre-declared list is one more guess to keep in sync. What follows below about the button
and about naming the tool is unchanged; what changed is that the grant is the project's
and is never asked for in advance.

**And the grant does not depend on a refusal.** The first implementation put it in two
places that both require something to have gone wrong or to be looked for: the edit form's
tick-boxes, and the amber block. The owner's report was the shortest possible review of
that — *«estou com dificuldade de achar o botão que eu permita»*. There is now a **«pode
usar: N ⌄» control beside «rodar agora»/«desligar»**, on the loop's ordinary screen, which
opens the same discovered list with a check on what is already allowed — the chat's own
menu idiom. `loop_allow` therefore takes `on: bool`: taking a permission back is the same
gesture as giving it, because a control that can only add cannot be corrected. Reused as-is: `err.intake_secret:<file>` (ADR-0024) and
`err.github_unreachable` — a clone that fails on the network says what every other
transport failure says (`looks_offline`, ADR-0027), never git's English.

Progress for a clone reuses the shape of `model-download-progress` (ADR-0006) if it needs
one; a local install does not.

---

## 7 · Construction rounds

| Round | Scope |
|---|---|
| **R1** ✅ | `loro.json` + manifest parsing + the class function + `brain_plugin_manifest` / `brain_install_plugin` / `brain_list_plugins` / `brain_remove_plugin`; local directory source only; **executable class refused by name**; the sidebar `＋` entry, the install sheet, the Configurações section. No loops yet |
| **R2** | `brain_export_plugin` — the acervo's custom habilidades become a pacote; scaffold a team catálogo (`.claude-plugin/marketplace.json`). The round that makes adoption two-way |
| **R3** | install from `owner/repo` / git URL with `ref`/`sha` pin, private repo via ambient credential, `brain_catalog_list`, *atualizar* |
| **R4** | **the loop**, after §4.11–§4.14 are settled and §9 is delivered: definition, the five surfaces, the state machine, the artifact, the history. Loops become a `kind`, disarmed on install |
| **R5** ◐ | open the executable door deliberately, if the owner decides to: explicit second confirmation, contents named, never in the wizard, recorded in `.loro/plugins.json`. Its own ADR — **ADR-0031**, whose R5a shipped: MCP over stdio, the supervisor, the three surfaces, source = a local directory only. It is a NEW door (`ext_install`, `.loro/ext.json`), not this one relaxed |
| **R6** | optional: submit Loro's own habilidades to `claude-community`, so Loro appears in the catálogo that already exists instead of asking for a visit to its own |

---

## 8 · Test scenarios

Red first, one per rule, naming the BR where a BR is touched (CLAUDE.md §3, §8).

**Package.** A valid `plugin.json` + `loro.json` parses; an invalid one fails as
`err.plugin_manifest_invalid`; unknown `loro.json` fields are ignored and an unknown
`loro` schema version is refused · **class is read from the tree**, table-driven: each
executable marker classifies executable even when `kinds` claims otherwise · **BR-9** a
pacote file carrying a vendor-prefixed credential refuses the whole install, and the
error names the file and the rule with **no finding text** (samples composed at runtime,
`amostra` — ADR-0024: a token-shaped literal in the source is refused by GitHub's push
protection) · **BR-8** the install logs id, version, counts and `err.*` codes only ·
**additive only**: a `loro.json` declaring a `block` rule or disabling an existing one is
refused, and `intake.secret` / `is_queueable` behave identically before and after ·
**path guard**: entries resolving outside the pacote root (`../`, absolute, symlink) are
refused (`err.plugin_path_escape`), `guarded_existing` reused rather than duplicated ·
**install is a pending change**: written files appear in `brain_git_state` /
`brain_git_diff`, nothing is committed or pushed · **id conflict** refuses by name, and a
`seed` pacote shadowing a builtin never touches the embedded bytes · **uninstall**
removes unmodified files, keeps an edited one and returns it in `kept`, never touches a
file it did not write · **non-Claude agent** + executable parts produces the named
refusal, never a silent inert install.

**Loop.** The state the backend enforces is the state painted (a loop reported as armed
fires; one that cannot fire says so) · **BR-8** over the cycle record: no produced text,
no transcript quote, in the record or the log · the triage and the review apply to what a
loop writes · an unattended run cannot use `bypassPermissions`
(`err.loop_permission_refused`) · a loop firing during a live chat turn resolves per
§4.10 and the panel says which (`err.loop_agent_busy` where it refuses) · a loop from a
pacote is installed **disarmed** · enrichment keeps the instruction readable (the
definition after N enrichments is still a document a person opens) · off-main-thread
guard on every new command · an English pair for every new pt-BR string (the existing
`app.js` and `index.html` sweeps); `tokens.test.js` needs no new value, since §5 adds no
token.

**Loop edge cases (§3.10), the ones a test can hold today.** `loop_status` is the only
authority the row, the header mark and the screen read (no second reader can disagree) ·
`armed` never survives a condition that blocks it — table-driven over every blocking reason
of §3.9, each producing `blocked` with its own code · a tick arriving while a cycle runs is
**skipped and recorded**, never a second cycle · the rhythm is computed from the last run's
wall-clock time, so a six-hour sleep fires **once** · a rhythm shorter than the last cycle's
duration is widened, and the widening is stated · with the app closed nothing runs and the
missed windows are **counted**, with at most one catch-up · consecutive quiet cycles collapse
into one row with a count · each ceiling stops the loop and names itself · the destination is
outside the loop's own reading scope by default · a denial mid-cycle never auto-answers
*liberar tudo e repetir* · a cancelled/interrupted cycle leaves no truncated artifact · the
per-acervo lock refuses the second window · deleting a loop keeps its artifacts, whose front
matter still names it.

---

## 9 · Design brief — delivered (2026-08-17)

*The pass happened: the eleven deliverables below came back as a Claude Design project
with twelve screens (1a–1m), and §13 records where its answers differ from what this
document assumed. The brief is kept verbatim, because it is the standard the drawing
was held to.*

Written in `docs/` in English, UI copy in pt-BR with its English pair. In this order:

1. **One page for a non-technical reader** — what a loop is, what it produces, what it
   never does.
2. **Anatomy and placement** — where each of the five surfaces lives, with an ASCII
   wireframe in the idiom of DESIGN.md §2, real measurements from `style.css`, and the
   behaviour with a narrow content column (✦ IA panel open — a container query, never a
   window media query, DESIGN.md §7) and with the sidebar collapsed.
3. **The state machine** — the eight states of §3.9, who changes each, and **how each is
   seen at the three distances**, under §5.2's constraints. `blocked` is the one to design
   hardest: every reason needs its own sentence and its own door. Every state the screen
   claims must be one the backend enforces, read from the single authority.
4. **The anatomy of one cycle** — what is recorded per run, how it is read without
   becoming an activity feed, and how it stays inside BR-8.
5. **The artifact as a document** — name, front matter, where it lands, and its route
   into ideias → fila → conhecimento without bypassing triage or review.
6. **"Enriquecer com prompt"** — the gesture: where the user writes, what exactly changes
   (the instruction itself? only the next cycle?), and how the loop stays readable after
   five enrichments. Note that enrichment history is prompt history — an ephemeral source,
   which the founding rule keeps unversioned.
7. **Copy table** — every pt-BR string with its English pair: empty states, the arming
   confirmation with its price, destructive confirmations, and the `err.<snake_key>`
   entries (no error may tell the user to click a label the HTML does not carry,
   DESIGN.md §4).
8. **What will explicitly not be built** — as load-bearing as the feature list.
9. **The IPC contract**, settling §6's loop sketch: commands, args, returns, events; what
   is read-only and what must leave the main thread.
10. **Test scenarios**, naming each BR touched, extending §8's loop half.
11. **§4.11–§4.14 answered**, each marked *decided* or *still open*, so this ADR moves from
    `proposed` to `accepted` by being edited rather than rewritten.

**Method.** On the two or three hard placements, present alternatives with their price,
recommend one, and say what it loses — a choice, not a survey. Reuse is the rule;
invention is the exception that argues for itself. Run every deliverable through the
DESIGN.md §9 checklist and say where it passes only barely. Where the design depends on a
premise that is not written down, **stop and ask**: the developer decides, and what is
decided gets recorded here.

**Reading list.** `CLAUDE.md` · `brain/contexts/loro/context.md` (premises, BR-1/BR-8/BR-9)
· `docs/DESIGN.md` **whole**, especially §1, §2 rules 1–10, §4, §7, §8, §9 ·
`docs/ARCHITECTURE.md` §2, §4.1, §4.2, §5 · ADR-0018, 0020, 0021, 0022 §19/§22/§28, 0024,
0026, 0027, and this one. Code: `desktop/src/index.html` (sidebar sections ~180, collapsed
rail ~222) · `desktop/src/app.js` (`renderTools`/`toolRow` ~3785, `brainPoll` ~2366,
`runAiCommand`, `dispatchAiFromSheet`) · `desktop/src-tauri/src/chat.rs`,
`presets.rs`, `intake.rs`.

---

## 10 · Consequences

- H-6's open point is answered: a habilidade becomes shareable by being a pacote, and the
  acervo records which pacote wrote what. H-2's "vertical skill catalog" is closed.
- A vertical no longer needs a Loro release — except the seven that stay embedded as the
  offline floor, on purpose (§3.6).
- `brain_list_templates` gains a source per entry, and the wizard's copy has to say it.
- `.loro/plugins.json` is a new versioned file, so it appears in a diff. Intended: which
  pacotes a project trusts is the project's policy, exactly like `autoContext`.
- The intake triage gains a fourth door and it is a *real* one — ADR-0024 lists three
  uncovered doors and this ADR does not close them; it simply does not open a fifth.
- One more thing can now go wrong on a machine that never ran the code, so an install must
  be reversible (§3.5) and legible in the diff (§3.4).
- §4.6 chose (a), so **no BR-1 amendment is needed**: nothing runs while the app is closed,
  and the arming is the user's explicit act. The price is that a loop is honest about what it
  missed (§3.10 B1) instead of pretending a rhythm it did not keep.
- A scheduler now exists where there was none (§2.4). It is **one** owner in the core, with
  one status authority (§3.9) — not a timer per feature.

---

## 11 · Explicitly NOT done

- **No hosted catálogo, no store, no accounts, no ratings, no payment.** A git repository
  is the distribution mechanism; this is already solved outside the app.
- **No sandbox.** Loro will not sandbox an executable pacote. Refusing by name is honest;
  a sandbox we did not write and cannot verify would be a claim the app does not enforce
  (DESIGN.md §1 — state must never lie).
  - **Still literally true after ADR-0031 R5a, and now it is said on the screen.**
    An extension's program is a peer process: `mcp::McpClient::spawn` runs it through
    `proc::command`, which removes 8 `CLAUDE_*` markers and nothing else — no
    `env_clear`, no jail, no network denial. What R5a added instead of a sandbox is a
    **named trust decision**: the command is a bare name resolved through the hydrated
    PATH, the argv is validated at manifest read AND again out of the versioned record
    before the spawn, and nothing runs until somebody on THAT machine approved exactly
    that command (`~/.loro/ext/<id>/trust.json`, the program stored verbatim). The
    install sheet and Configurações both say the second half out loud — a started
    program runs with the person's own access (ADR-0031 §14, §17).
- **No auto-update.** An update is a change and passes the same door; *atualizar* is a
  user action.
- **No extension point into the app itself** — no JS injected into the webview, no new
  Tauri command from a pacote, no UI slots. The restrictive CSP and the minimal command
  allowlist (ARCHITECTURE §7) are load-bearing; a webview extension point is an attack
  surface with no way back.
- **Nothing pluggable in the kernel:** audio capture, the whisper spawn, the path guards,
  the triage blocks and the git/`gh` writes stay fixed. A pluggable kernel turns
  BR-1/BR-8/BR-9 from guarantees into defaults.
  - **AMENDED on one line by ADR-0031 §12 (2026-08-19): the transcription ENGINE
    opens; the GUARD does not.** The reason above is kept verbatim and is what does
    the narrowing — what turns a guarantee into a default is a **replaceable guard**,
    not a replaceable engine. A `transcriber` point is therefore admissible in
    principle: spawned by Loro, local, and **network-denied for its whole life**, which
    is a refusal enforced at spawn instead of by the absence of a feature. Audio
    capture itself, the path guards, the triage blocks and the git/`gh` writes stay
    exactly as this line left them — an extension never sits between the microphone and
    the disk and never decides whether a recording happens.
    **Not in the code, as of ADR-0031 R5a** (measured, `ext.rs`): `SUPPORTED_POINTS`
    is `["surface"]`; `transcriber` exists only as a name in `KNOWN_POINTS` — reported
    as unsupported instead of silently dropped — and in `AUDIO_POINTS`, whose only job
    today is to refuse an audio-holding point declared together with any `net.*`
    capability at the door (`err.ext_audio_network`, BR-1's absolute half, no consent
    path). So the door is open in the decision and closed in the code.
- **No second scheduler.** The clock of §4.6 is a single owner in the Rust
  core — not a timer per feature and not a frontend clock pretending to be one.
- **No loop writing official knowledge on its own** (§3.8.6).
- **No activity feed, no dashboard, no statistics** on Home (ADR-0020 §4, DESIGN.md §8).
  A loop's history is read where the loop lives.
- **No new viewer for artifacts** — they are documents.
- **No outbound notification from a cycle** (e-mail, Slack post, webhook). Outbound has
  its own door (`/loro-slack`, the agent's own connector) and it is user-triggered; an
  automated outbound message is a separate decision.
- **No pacote arming a loop** (§3.8.1).
- **A catálogo of knowledge** (selling filled contexts) — §4.5.

---

## 12 · Alternatives considered

- **Invent a Loro-only package format.** Rejected: the habilidade already *is* a plugin's
  `commands/*.md`, and a private format would mean neither Loro's pacotes nor the
  ecosystem's could be used by the other.
- **Make everything a plugin, kernel included** (the strong reading of the DeepSeek
  framing). Rejected per §11: what gives Loro its value is precisely what must not be
  swappable.
- **Allow the executable class from round 1, behind a warning.** Rejected: it asks for an
  audit inside an install sheet.
- **Keep the pacote outside the acervo** (in `~/.loro/plugins`, like custom templates).
  Rejected for the acervo-scoped parts: a habilidade the team's review never saw is
  knowledge infrastructure nobody approved. The trade-off is real, and it is §4.4.
- **Two ADRs, one per observation.** Rejected after drafting both: the loop's central
  tension and the pacote's are the same tension (§2.5), and splitting them produced two
  documents answering it differently.

---

## 13 · What the design pass changed in this ADR

The screens answered §9 and, in three places, **corrected** what this document had
assumed. Each one is recorded rather than quietly absorbed:

1. **Seven states, not eight.** `pausado` was merged into `desligado` — for a person
   they were two offs with different names, and one state must have one appearance
   (DESIGN.md §1). What survives from the pause idea is that switching a loop off
   mid-cycle does not kill the cycle: the state still reads `rodando` until it ends,
   because that is what is true.
2. **The UI word for a pacote is «plugin», not «pacote».** §3.1's vocabulary table
   proposed *pacote*; every screen says *plugin* (Instalar plugin, Configurações →
   Plugins, «veio do plugin X»). Loro speaks the ecosystem's FORMAT (§2.2), so
   speaking half of its vocabulary would have been the odd choice. *Pacote* survives
   in prose, as a synonym.
3. **A loop may write to the knowledge.** §4.7 put the artifact in the non-versioned
   world; the design added a third destination — **o conhecimento** — where the cycle
   writes into `contexts/**` on the working draft and the change appears in Revisão
   with the loop named on the card. §3.8.6 still holds (the loop **proposes**; the
   person saves, sends and approves), but §4.7 is wider than it was, and the widening
   is the decision.

Two smaller ones: the loop's five surfaces collapsed into three real places (the tree
row · the header mark + ⟳ Loops tab · the loop's own screen, where *create* and *edit*
are the SAME screen), and the day-of-week control became the app's own `.segrow`
instead of the design's circles — reusing the component beats drawing a seventh kind
of toggle (DESIGN.md §9).

---

## 14 · What the implementation taught (2026-08-17/18)

The code was written, then **reviewed adversarially** (six lenses over the diff —
backend correctness for each module, frontend runtime behaviour, regression risk,
DESIGN.md/a11y compliance, and this ADR's own contract — with every claim handed to
a skeptic before it counted). Forty findings survived refutation. All of them were
fixed; the ones that change what this document says are recorded here, because an
ADR that describes the design rather than the code is worse than no ADR.

### The two defects that were vulnerabilities

1. **`.loro/plugins.json` is versioned, therefore it is untrusted input.** It
   arrives in someone else's commit. `remove` resolved each recorded `rel` with a
   bare `base.join`, so a record carrying `../segredo.txt` deleted a file OUTSIDE
   the project. Every recorded path now goes through the same guard as every other
   acervo path (`guarded_existing`), and a path that does not resolve inside the
   project is **kept and named** instead of touched. The record being versioned is
   what made this reachable — and that is exactly why §3.4 versions it, so the trade
   is stated: **policy that travels is input that must be guarded.**
2. **A pacote could install an ARMED loop.** `disarm_markdown` matched the literal
   prefix `ligado:` on a trimmed line while the parser trimmed the KEY, so
   ` ligado: true` (one leading space) survived disarming and parsed back as armed —
   §3.8.1 defeated by an indent. The disarm now recognises the key exactly as the
   parser does. It is the one place in this ADR where a careless byte becomes
   autonomous work nobody armed, and it has its own test with all four spellings.

### Where the code did not do what this document claimed

3. **§3.8.3 was a claim, not code.** A cycle's output never passed the intake
   triage. It does now (`intake_block_of`), with one honest amendment to §3.10 E1:
   the file is **not** removed. Deleting the agent's work in silence would be worse
   than saying so — the cycle ends **blocked**, the state turns amber, and the reason
   names the file. The finding itself never travels (BR-8).
4. **§3.10 E1's sibling, in the plugin door:** a file that cannot be read as UTF-8
   was skipped by the triage and installed anyway. A habilidade IS text, so an
   unreadable file is now refused by name (`err.plugin_unreadable_file`) — and the
   install validates every source **before writing any of them**, the pattern
   `brain_send_files_to_queue` already used, because a half-written install left
   orphans and no record.
5. **§4.7's destination was not local.** `loops/<slug>/` — the default destination —
   was NOT quarantined from git, so every cycle's material was committable and made
   the working tree dirty (which can refuse a merge or a branch switch). `loops/*/`
   joined `GIT_IGNORED`; the **definition** beside it (`loops/<slug>.md`) stays
   versioned, which is the whole distinction of §3.8. `matches_ignore` gained a
   single-segment `*` so the read path and the written `.gitignore` cannot disagree.
6. **§3.9's authority had two holes.** A loop that hit its daily ceiling read
   «ligado · próxima execução em 30 min» for the rest of the day, and a permission
   denial read «falhando» while it retried five times and then disarmed a loop that
   was never broken. The ceiling is now a blocking reason, and what needs a PERSON
   (`needs_person`) blocks instead of failing — cleared when the person decides
   something. The screen also stopped promising a next run for any loop that cannot
   run, and `expirou` now wins over `desligado` (the tick disarms on expiry, so read
   in the other order the person never learned the loop had reached its end).
7. **A pre-migration acervo would have grown a second knowledge folder.** The plan
   hardcoded `contexts/` while the seeder used the legacy-aware resolver, so on an
   acervo still carrying `contextos/` the preview promised one path, the conflict
   check looked at another and the write landed in a third. The plan now names the
   folder that EXISTS.

### What the review taught about the mechanics

8. **Nothing marked a run at its start**, so `due()` stayed true for the whole cycle
   and every 30s tick recorded another «pulado» — a four-minute cycle grew eight
   history rows that were not cycles. The run is marked when it starts.
9. **`paralelo` was decided in the tick and enforced nowhere.** Two loops due in the
   same minute both started with «um por vez» configured. The slot is now
   **reserved under the lock** in `start_cycle` (which also closes a TOCTOU between
   two «rodar agora» clicks), and the queue re-checks `ligado`/`expira` before it
   drains — waiting in the queue had been a way to run a loop the person had just
   switched off.
10. **Stopping a cycle left no marker**, so the record said «nada novo» about a cycle
    the person interrupted. **A cancelled cycle now says `stopped`.**
11. Smaller ones, each with the same shape — the interface knowing something it did
    not say: a modified file reported as «nada novo» (the snapshot compares
    fingerprints now, and attributes only what moved after the cycle began, because
    the knowledge tree has other writers); the step counter double-counting because
    `--include-partial-messages` repeats a `tool_use`; the file brake walking the
    destination on **every** stream line; a CRLF definition parsed with the body
    offset off by one byte per line; the lock outliving a crash for half an hour (now
    a 3-minute TTL with a heartbeat); a step left «rodando» forever when the brake
    killed the process; a queued cycle that could not be selected in the panel; the
    loop form leaking between tabs; the 10s repaint erasing what the person was
    typing; and, on the design side, a field labelled by a `<span>` instead of a
    `<label>`, a repaint that dropped the keyboard, a selected row with no
    `aria-current`, a dead `.tnode` selector, a bin label written with a person's own
    words, and a sentence set in the machine's typeface.

### What §4.17 taught on the first real refusal (2026-08-18)

Two defects, both found by the owner on the running app rather than by 861 tests, and both
of the same family — a surface that states a fact it did not have:

1. **The denial had no name**, because the path that carries the id is not the path a real
   refusal takes (above). A mechanism verified only against the shape you *expected* the
   CLI to produce is verified against yourself.
2. **The history called a blocked cycle «falhou».** `outcomeTone` had no case for
   `blocked`, so the dot fell through to `muted`, and the row painter's last branch
   labelled it *failed*. The backend had recorded the outcome correctly all along: the lie
   was one missing case in the painter, in the one place §3.9 exists to keep honest.
   `blocked` is amber — «precisa de você» — and it now says *impedido* with the reason.

3. **A working cycle was recorded as blocked.** Read from the owner's own acervo:
   `outcome: "blocked"`, `err: "err.loop_permission_refused"`, `steps: 9`, and
   `files: ["…/insights-20260818.md"]` — the file the instruction asked for was sitting in
   the folder while the screen said the cycle had needed a permission nobody could grant.
   Two causes, one on top of the other:
   - **`looks_like_permission_denial` was run over the text of SUCCESSFUL steps.** It is a
     heuristic over prose, and the prose of a successful `tool_result` is *content*: a page
     `WebFetch` returned containing «permission» and «request» became a refusal that never
     happened. `is_error` was already read on that very line and was not used to decide.
     A denial is now only read from an **error** result.
   - **A refusal in the middle erased the work.** The outcome chain checked `permission`
     before it looked at what came out. When files were produced, the refusal is a **note
     on a cycle that worked**, never a blocked cycle — and therefore never a pending
     question that freezes the loop until someone turns it off and on.

   The branch order is now a pure function (`loops::cycle_outcome`) with a test naming each
   precedence, because that order *is* the policy and this is the second time it was wrong.

The lesson the tests took: the first two are now covered in the **real DOM**
(`tools/smoke-ui.js`), not only in source scans, and the blocked-cycle step was verified to
fail with the case removed. A tone table with a missing enum is invisible to a source scan
that looks for the enums it knows about. The third could not have been caught by any test
written against the shapes we imagined — only by reading a real record on disk. When a
surface and a folder disagree, the folder is the witness.

### The mode was never the boundary (2026-08-18, read from a session log)

The owner ran a cycle and reported that no request appeared. It had not: every tool call in
that turn succeeded. What the log showed instead was the cycle running **`Bash`** —
`find /Users/…/Desktop`, `ls -la` — with `is_error: false`, under
`--permission-mode acceptEdits`.

So `acceptEdits` auto-approves Bash in this CLI, and **three claims this document and the
screen were making were prose, not mechanism**:

- «permissão: **ler e editar o projeto**», printed beside every loop's actions — the cycle
  listed a directory outside the project;
- «comandos livres não são de um ciclo» (§4.17/§4.18) — Bash was refused as something to
  *offer* while it was already running;
- «**a loop never runs git**» (§8/§3.8) — a rule the prompt asks for, which the agent was
  free to ignore.

The fix is one flag and a pure function: `--disallowedTools` is now passed on **every**
cycle, never conditionally, and `Bash` is always in it (`loops::NEVER_FOR_A_CYCLE`). It
cannot be granted by any spelling — `safe_tool_name` refuses it for the allow list, and
`cycle_tool_flags` has a test that tries `bash`, `Bash(git *)` and `" Bash "`. §3.8's
invariants stop depending on the agent's cooperation.

**What this leaves open, deliberately:** scoped execution. The CLI accepts
`--allowedTools "Bash(git *)"`, so a narrow grant is possible and would make the loop the
owner was actually trying to build («leia os arquivos do desktop») expressible. That is
§4.3's door opening a crack, and it does not open by omission — it needs a decision, and
`--add-dir` for a path outside the acervo needs one too.

**And the lesson, again the same one:** a permission mode is a claim by the vendor about
the vendor's behaviour. It was written into our copy as a fact about ours. Nothing but the
session log on disk would have shown the difference — no test we wrote could have, because
every test we wrote asserted the flag we passed, not what the CLI did with it.

### «Nada novo» in relation to WHAT? (2026-08-18, read from four cycle records)

Right after the Bash lock, the owner ran the loop again and pasted its steps: `Glob ✓`,
`Read ✓` seven times — every call fine, no Bash, nothing outside the project. And the
cycle's final text was, literally, `nada novo`. The record agrees: four cycles at 4, 10 and
8 steps, seven documents read, zero files produced, while the person waited for the insights
they had asked for.

The cause is a contradiction §3.10 D3 and the prompt wrote together:

- «**never read this loop's own output folder** — it is what you wrote yourself» (D3, so a
  loop does not feed on itself), and
- «**if there is nothing new to say, write no file and answer «nada novo»**» (D1, so a quiet
  loop does not become a file factory).

Nothing new *in relation to what?* The cycle was forbidden from seeing what it had already
said and then asked to judge whether it had anything to add. Blind, and told to do «what the
instruction asks and nothing else», the safe answer is silence — every time, forever.

The fix separates the two things D3 was conflating. The output folder is **not material**
(the loop still never mines its own prose as project input), but the cycle is now TOLD what
it produced — names and dates from the runtime record, never content — and told to open the
most recent one before deciding. And «nada novo» is offered **only when there is something to
compare with**: on a first cycle the escape hatch does not exist, because there it would be
an invitation not to do a job nobody has done yet.

A quiet cycle is still a legitimate outcome (D1 stands, and the history still collapses
them). What changed is that it is now a **decision** instead of a guess.

**And the decision was still «nada novo», which exposed the real gap.** With the fix in place
the owner ran it again: the cycle opened `insights-20260818.md`, read the index, both meetings
and both analyses — seven documents, every call fine, no Bash — and answered `nada novo.`
It was right: nothing in the material had changed since the previous cycle. Two things were
nonetheless wrong, and neither was the loop's judgement:

1. **The prompt offered two paths where the job needed three.** «Write a new file» or «say
   nothing» — never «**improve the one you already wrote**». For a *generative* instruction
   («me dê insights sobre o tema») over material that changes slowly, updating is the only
   honest output, and `changed_since` has always recognised a rewritten file (length + mtime,
   the very reason it was written that way). The third path is now offered, and named as
   preferable to creating a near-duplicate beside the first.
2. **The screen said nothing at all.** «Rodar agora» reported only failures, and a quiet
   cycle was the ONE row in the history that did not expand — the person clicked, the cycle
   read seven documents, and the interface showed a grey line with nothing behind it. Five
   times. «Rodei e não aconteceu nada» was literally true of the interface. Now: a cycle the
   PERSON started always reports its outcome (an automatic one stays quiet — the header mark
   is its signal), and every row expands, with the quiet one explaining what «nada novo»
   means.

The guarantee is pinned to the real case: `the_owners_own_loop_gets_all_three_paths_and_no_way_out_of_the_project`
builds the def and the runtime read off that acervo's disk and asserts the prompt it would
receive.

### «Não está me aparecendo a permissão» — and no permission had been asked for

The owner pasted a cycle's steps: `Read !`, then `Read ✓`, `Glob ✓`, five more `Read ✓`, and
`Edit ✓`. Two facts, from the record and the session log:

- **The loop was working.** The last two cycles are `ok`, each with the same one file: it
  **updated** `insights-20260818.md` instead of writing a near-duplicate or going quiet. The
  third path added above is what a generative instruction needed, and `changed_since`
  recognised the rewrite exactly as it was designed to.
- **The `!` was not a permission.** It was `EISDIR: illegal operation on a directory, read` —
  the agent tried to `Read` a folder, recovered with `Glob`, and finished.

So nothing was broken, and the person's conclusion was still **correct for what the screen
gave them**, which is the defect:

1. **The loop panel threw the step's RESPONSE away.** `loop-tool-result` carries the text
   (capped, the same payload the chat renders) and the panel kept only `done`/`failed`. A
   mute «!» made `EISDIR` and a refused connector look identical — the reason was invisible.
2. **A refusal had no name and no action.** Both painted the same «!». Now a
   permission-refused step says *faltou permissão para usar X* inside the step that provoked
   it, with the same one-click decision as the request card — and when the tool is one a
   cycle never gets, it says that instead of offering an action that would fail.

**And the harness grew a limb.** The stub used to discard event listeners, so every
event-driven surface — the steps of a cycle, the end of a cycle, the chat's deltas — was
verified by reading source only. It now keeps them and exposes `__SMOKE__.fire(name, payload)`,
so the smoke drives the real listeners and measures the DOM they produce. Both defects above
are covered that way, and both were verified to fail with the fix removed.

*(One trap for the next person: the smoke runs under Chrome's `--virtual-time-budget`. When
the script outgrows it, Chrome stops mid-run and the output reads «o driver não chegou ao
fim» — which looks exactly like an app defect and is not. The budget is the script's clock;
it grows with the script.)*

### The material was invisible in the tree (2026-08-18)

«Os arquivos gerados não estão aparecendo em auto reload na árvore lateral.» Two defects
under one sentence, and the first is worse than auto-reload:

1. **The LOOPS section never showed what a loop produced.** It was a flat list of loops with
   their state. And the DEFAULT destination is `loops/<slug>/`, which appears in no other
   section — ideias shows `brainstorming/`, conhecimento shows `contexts/`. So a loop with
   the default destination wrote material that was **invisible in the whole sidebar**,
   reachable only from the loop's own cycle rows. §8.5 says the artifact is an ordinary
   document; it was not in the one place documents live. A loop row now expands (the same
   `rowtoggle` a meeting uses) and lists **its own destination** — the loop's folder, or an
   idea's attachments — with the knowledge destination saying where the decision lives
   instead of listing a tree other hands write.
2. **And the repaint could not see a new file.** `refreshLoops`'s signature was state +
   rhythm + last run + blocked: nothing a produced file changes. It now includes the listing
   of every EXPANDED loop (`loopKidsSig`), which is the rule `pessoalSig` already followed
   for an expanded idea. Both the cycle-end event and the 10s tick now surface a new file
   with nobody clicking anything.

The caret costs no width: measured on the real DOM, the row is 225px and a separate button
took the name from 80px to 59px while it needed 69, so the caret took the **icon's** slot —
the loop icon is identical on every row of a section that already says «loops», while the
caret says the one thing only it can. The tone stays in the dot. A floor on the name's width
is now measured in the smoke, so the next control cannot eat it in silence.

### An ordinary document, all the way down (2026-08-18)

«Devo poder mover, copiar path, deletar entre outras funcionalidades.» §8.5 said the artifact
is an ordinary document; the tree row was showing it and offering nothing. The row now carries
the **same ⋯ every file in the tree carries** — *pedir à IA · renomear · mover para… · copiar
caminho (relativo e absoluto) · apagar* — reusing `openArtefatoMenu` verbatim rather than a new
menu with a subset of it.

What that required in the backend is the honest part: `rename_pessoal_file`,
`move_pessoal_file` and `brain_brainstorm_delete` recognised exactly two worlds,
`brainstorming/` and `pessoal/`, and refused everything else with `err.outside_brainstorm`. A
loop's material was a **second-class document by construction**. There is now one rule
(`acervo::pessoal_world_of`) with a third world: `loops/<slug>/`, which belongs to the same
class because it is git-ignored like the other two (`GIT_IGNORED` carries `loops/*/`).

**The definition does not come through that door.** `loops/<slug>.md` is versioned, it is the
document the person reads and edits, and removing it is `loop_delete` — which also cancels a
running cycle and forgets the runtime record (§3.10 F3/F4). So the rule counts SEGMENTS rather
than matching a prefix: `loops/<slug>/<file>` is material, `loops/<slug>.md` is not, and a test
asserts all three verbs refuse it.

Moving a loop's file into an idea is offered, and that is deliberate: «this insight is good,
file it under the idea» is the path from material to knowledge that §4.7 describes, and the
move sheet already listed exactly those destinations.

### And one thing the suite could not have caught

The boot line `setInterval(loopTick, LOOP_TICK_MS)` was placed above the `const` it
reads. The temporal dead zone threw at load, **the whole of `app.js` after that
point never ran**, and all 849 tests stayed green — because the suite reads the
SOURCE (there is no DOM under `node --test`, by decision). That is now covered by
`tools/smoke-ui.js` / `make test-ui`: the real `index.html` and `app.js` in a
headless Chrome with the backend stubbed, driving the surface step by step. It is
deliberately outside `make test`, which stays portable — the same posture as
`tools/measure-header.js`, whose worst case also grew a case here (the header now
carries a SECOND non-shrinking pill, so it is measured recording **and** with a
cycle running, in both languages).

---

## 15 · Docs sweep (CLAUDE.md §8.9) — done

Done with the implementation: `desktop/src/manual.pt.md` + `manual.en.md` (what a
pacote is, how to install one, what Loro refuses and why; what a loop is, how to arm one,
what it never does) · `docs/ARCHITECTURE.md` (§2 contexts — the acervo gains an install
path and the app-lifetime clock of §4.6; §4.1 commands, §4.2 events, §5 flows, §8 decision
table) · `docs/DESIGN.md` (§4 vocabulary rows, §8 the "does NOT go in" lines) ·
`README.md` · `brain/contexts/loro/context.md` (H-6 updated, H-2's catalog point closed,
a hotspot for whatever §4 leaves open; **no BR-1 amendment**, per §4.6).
