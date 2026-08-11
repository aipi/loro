# Loro Manual

_Loro captures your speech and texts locally and turns everything into a
per-context knowledge base — private, versionable and reviewable. No audio or
text leaves your machine without an explicit action from you._

## The flow in one sentence

**Brainstorming → Queue → Context**: you gather raw material (meetings, notes,
attachments) in a brainstorming; you select the **files** that matter and each
one enters the queue as itself (one item per file — there is no consolidated
report anymore); "generate context" asks the terminal Claude to distill the
queue into `contextos/` — the official source of truth, versioned in git.

## The screen, at a glance

Every screen shares one anatomy:

```
HEADER 54px — [project ⌄] [Home · Organize · Knowledge] ··· [Record] [✦ AI]
SIDEBAR      │ TABS (only when a document is open) │ PANEL 330px
250px or 60px│ CONTENT                             │ Document · Chat · Terminal
```

- **The three destinations** live in the header: **Home** (what do you want to
  keep today), **Organize** (what you captured that has not become knowledge
  yet — the amber number is the count) and **Knowledge** (the team's official
  topics).
- **Record** is the red header button; while recording it becomes **Stop**, and
  recording continues if you switch tabs — a `recording · mm:ss` pill in the
  header takes you back.
- **If you listen through speakers**, the mic hears the others back, and the
  same sentence enters both tracks. Loro drops the copy by itself; if it still
  mixes up who spoke, turn on **cancel speaker echo** in Settings → Capture —
  at the cost, stated there, of your voice coming out quieter. With
  headphones, leave it off.
- **The recording footer** is the same for a loose recording and for a meeting:
  clock, waveform and the privacy pill at the foot of the content. In a meeting
  it also carries **⏸ pause / ▶ resume** and **■ End meeting**, left of the
  clock. Pausing **really stops capture** — nothing is recorded until you
  resume, the clock freezes and the menu-bar parrot stops blinking.
- **✦ AI** shows or collapses the right-hand panel.
- **Tabs are open documents only** — there is no "Home" tab. One click in the
  tree opens a preview tab (italic); a double click pins it.
- The **sidebar toggle** (250px ⇄ 60px) sits at the bottom, next to
  **⚙ Settings**.
- `Cmd/Ctrl+K` opens the **palette**: files and commands in one list, grouped
  into *go to · record · create · document · do*, each with its shortcut on the
  right. It is the living list of everything you can do.

### The chat (✦ AI panel)

The **Chat** tab talks to **your project's agent** — the same CLI that runs in the
embedded terminal (Settings → AI and terminal). Nothing goes to a Loro API: the
process is local and the account is yours.

- Type your question and send (Enter; Shift+Enter for a new line). The answer
  streams into the chat itself.
- The **chips** above the field are the most-used AI skills. Clicking one arms
  it; sending with no text runs it with its default instruction, and `×` unsets it.
- The conversation **continues** from one question to the next. **restart** starts
  over.
- `sonnet · high ⌄` is a single control: pick the **model** and the **effort**
  (how much the agent thinks before answering).
- The ↑ becomes **■** while answering — click it to stop the turn.
- If the agent needs **permission** to touch the folder, an amber block appears:
  **Allow this folder** (for this conversation only) or **Continue in the
  terminal**, where it can ask you step by step.

- **Where AI skills run** is your choice: **Settings → AI and terminal**.
  *In the chat*, the answer stays in the conversation; *in the terminal*, you
  follow each step and can step in. It applies to everything — analysing a
  meeting, asking the project, running an action from a ⋯ menu.
- The three sidebar sections (**ideas**, **to organize**, **knowledge**)
  **collapse**: click the heading. With many topics that is what keeps the tree
  navigable.

- **What the chat may do** is also your choice (**Settings → AI and terminal**).
  The chat cannot stop and ask mid-action, so it ships able to act: *read and
  edit the project* covers analysing a meeting and writing notes; *everything,
  without asking* also allows external connectors (Slack, Drive…) and paths
  outside the project folder.
- Every step the agent took (a tool it used) **opens**: click it to see the
  request and the response. A failed step opens on its own.

### Adjusting the widths

All three side columns are adjustable: **drag** the divider between the ideas
sidebar and the content, between the content and the ✦ AI panel, or the top of
the terminal when it is docked at the bottom. **Double-click** a divider to reset
it. Your choice is remembered.

### What things are called

Loro speaks your language on screen and keeps the technical names on disk:

| On screen | On disk / in the ADRs |
|---|---|
| project | acervo |
| ideas | brainstorming |
| to organize | fila (`inbox/`) |
| knowledge | contextos |
| AI skills | habilidades |
| save version | versionar (commit) |
| send for team review | propor mudança (RFC = PR) |
| merge into a knowledge topic | promover |

### Theme

In **Settings → Appearance** you pick **light**, **dark** or **system**
(follows macOS/Windows).

## First steps

On first launch a **welcome modal** sums up the main features (flow,
recording, templates, agent, AI and shortcuts) — reopen it anytime via the
palette: `Cmd/Ctrl+K` → "Loro tour".

1. **Create the knowledge base** — on first launch the wizard asks for a name,
   the folder to generate into and the initial contexts (e.g. `product`,
   `engineering`). Check "version with git" to enable the review flow
   (recommended).
2. **Usage template** — the first option is **Automatic** (default): the loop
   creates and assigns contexts on its own when it processes the queue, so
   you don't need to define contexts now (you can turn it off later in
   Settings). The other options are ready-made templates (Sales,
   Engineering, Product & management, Learning, Education, Hiring,
   Healthcare) or the Generic (blank) one — with those, you define the
   contexts and the loop won't create new ones on its own. Each template
   prefills the contexts (still editable), appends the vertical's rules to
   `AGENTS.md`, seeds the queue guide and sets the `context.md` mold of
   every context (sections vary per vertical — sales talks pipeline and
   commitments, healthcare talks practices and protocols). Each option's
   explanation appears right below it when selected.
   "Duplicate to customize" copies any template into `~/.loro/templates/`,
   where you edit the files and it shows up in the wizard. Templates that
   touch personal data (Sales, Hiring, Healthcare) ship minimization rules —
   Healthcare warns explicitly: health data is sensitive and the base never
   replaces the medical record.
3. **AI agent** — the "AI agent (command)" field sets which CLI the embedded
   terminal uses for this base: `claude` (default), `gemini`,
   `ollama run llama3`… The base is just files + convention (`AGENTS.md`),
   so any agent — including a local model — can work on it; for agents that
   don't understand slash-commands, Loro sends the skill instructions as
   plain text.
4. **Transcription models** — in Settings (⚙) → *model*, each model shows as
   **installed** or with a **+ download** button. The download runs on your
   computer, shows progress, and is verified by SHA-256 before it takes effect.
   `large-v3-turbo` is more accurate; `small` is faster and lighter. If you try
   to transcribe with no model present, Loro opens Settings so you can download
   one. (Installed via Homebrew, whisper and ffmpeg come bundled in.)
   An interrupted download never becomes a model: a file is only used once it is
   whole and verified. If an older model was left half-downloaded, it shows as
   *not installed* again — just download it once more.
5. **Language** — in the gear (⚙), "interface language" switches pt-BR/English.
   Everything the app **generates** (analyses, meeting documents, contexts) is
   born in the active interface language.
6. **Version** — the footer of Settings (⚙) shows the installed version
   (e.g. `v0.8.0`), so you can tell at a glance whether an update landed.

## Record and transcribe

- **● (record)** opens the recording dialog asking **where to save**: a
  brainstorming (it becomes a meeting tied to the topic) or a "one-off
  transcription" (the text stays in the live panel to save/discard at the
  end). The global shortcut is `Cmd/Ctrl+Alt+Space`.
- Every palette command (`Cmd/Ctrl+K`) has a `Cmd/Ctrl+Alt+<key>`
  shortcut, shown next to the command in the palette itself.
- **Sources**: microphone, system audio (requires BlackHole — the app guides
  the install) or **meeting** (mic + system together; transcription happens at
  the end, with better fidelity).
- Audio is **transient**: used to transcribe, then discarded. The privacy
  indicator in the bar shows the state ("not recording" / "records audio").

## Brainstorming (the non-versioned world)

- **Write a note** (on the Home screen) opens a **blank** markdown right away:
  you write first and, on save, you pick the title and where the note lives — an
  existing brainstorming topic or a context. Until you save, nothing is written
  to disk.

- The **＋** in the section header creates a brainstorming (a private space
  for a topic); the contexts section's **＋** creates a context.
- Inside it (expand the brainstorming in the sidebar): each folder has its
  own creation action at the top — **notas** → **＋ new note**; **reuniões**
  → **● record meeting** (also in the palette `Cmd/Ctrl+K` → "nova
  reunião"); **anexos** → **⇄ sync** (brings from Drive/Slack/Jira/
  Confluence) and **＋ from computer** (opens the file picker and copies a
  `.pdf`/`.xlsx`/image you already have into the topic's anexos).
- **✦ AI note** (the brainstorming's ⋯ menu) creates a note from your
  request; **✦ ask the AI** (a note's/analysis' ⋯ menu **and the right-side
  rail of any open file**) applies a request to the existing content — the
  AI evolves it, never erases.
- **⋯ menu on a meeting**: beyond rename and delete, **⇄ move to…** takes the whole
  meeting — transcript, analyses and generated material — into another
  brainstorming — available once the meeting has finished, like analysing and
  queueing. You can also drag the meeting by its icon onto the destination's
  **📁 reuniões** header. A meeting with the same name at the destination is never
  overwritten.
- **⋯ menu on any file** (note, attachment, misc, meeting note): beyond
  **rename** and **delete**, it offers **⇄ move to…** (pick the destination
  folder — misc, or any brainstorming's notes/attachments folders) and
  **⧉ copy path** — **relative** (portable, the format used by `acervo://`
  references) or **absolute** (the full on-disk path, handy to open in
  Finder/terminal). A same-named file at the destination is never overwritten.
  **Copy path** is on the ⋯ menu of **every item in the sidebar tree** — files,
  brainstormings, meetings, queue items, contexts, folders (attachments) and
  habilidades, plus the sources.
- **Drag and drop:** drag a file's **icon** (the cursor turns into a grab
  hand) onto a folder header (📁 notes, 📁 attachments or 📁 misc) to move it —
  the same effect as **move to…**, confined to the brainstorming world (never
  touches versioned content). The rest of the row stays click-to-open.
- **Right-side actions rail:** opening any note/document shows separate
  action cards on the right — **habilidade** (a dropdown with friendly
  names; the selected habilidade's description stays visible right below
  it, and **▶ executar** runs it against the open file), **ask the AI…**,
  and **version** (when the file is part of a context). Same pattern
  everywhere these actions exist — meeting, regular document, acervo header.
  In **edit mode** the editor fills the whole panel and the rail is hidden;
  the actions stay available in view mode.
- **Formatting bar in edit mode:** above the editor there are buttons for
  **bold** (⌘B), *italic* (⌘I), strikethrough, headings (H1/H2/H3), bulleted
  list, checklist, numbered list, quote, code, link (⌘K), table, code block
  and horizontal rule. They write the markdown syntax at the cursor (or wrap
  the selection) and undo it when you click again on text that is already
  formatted — the file stays readable markdown, so the git history shows only
  what you actually changed. The same bar appears in the editor for queue
  drafts and loop instructions, where **⌘S** saves.
- The **analyse**, **ask…** and **send to queue** actions
  live in the meeting's **⋯** menu in the sidebar. **Ask…** already works
  while the meeting is still recording; the other two enable once the meeting
  ends. **Send to queue** sends the meeting's **analyses** (whatever is in
  `notas/`) — the raw transcript never goes. A meeting nobody analysed has
  nothing to send, and the menu says so instead of failing on click.
- The meeting's `reuniao.md` tab shows, instead of fixed buttons, a single
  **habilidade dropdown** ("o que fazer com esta reunião") — pick any
  habilidade (including analyse/ask) and run it against the open meeting.
  Unrestricted: every habilidade shows up there, built-in and custom.
- In a meeting: use **✎ Mark moment** (`Cmd/Ctrl+Alt+M`, or the button above the
  transcript) to anchor the instant something important was said — one marker,
  no kind to choose mid-sentence; then run **analyse**
  (⋯ menu) so Claude writes the analysis into `notas/`. When the recording ends
  the app opens the transcript and **offers** to analyse in one click — a
  suggestion, never a run, and it goes away if you ignore it.
- Nothing in a brainstorming is versioned or leaves the machine.
- A meeting's **notes** (analyses, answers and any document a habilidade
  produces) are **collapsed by default** in the sidebar (tap the ▸ arrow next
  to the meeting to open) — keeps the list from growing huge once you've
  analysed several meetings. Everything a habilidade produces about the meeting
  goes into its **notas/** folder (no more separate investigations/answers
  folders).
- Every brainstorming has exactly three folders, visible in the sidebar as
  collapsible groups with a folder icon (📁 **reuniões**, 📁 **notas**,
  📁 **anexos**): **reunioes/** (every meeting is
  born there), **notas/**, and **anexos/** (a presentation is just one kind
  of anexo — no folder of its own). `anexos/` is fed by a habilidade (sync,
  presentation, artifact) or by dropping a file straight into the real
  folder on disk.
- With many brainstormings, a search box appears above the list (past 8) —
  filters by name; with no search, it shows the most recent + "ver todos".

## Habilidades (skills)

Habilidades are AI-agent actions — some ship ready-made (built-in), others
you create. They no longer live on the Overview: run one from a
brainstorming's **⋯** menu → **"executar habilidade…"**, from the
**"executar habilidade…"** button at the top of **any markdown file's**
viewer, or from the habilidade dropdown on an open meeting. Always a
compact menu/control — each item's description only shows on hover, so it
doesn't clutter the screen once there are many.

- **Sync** brings an external item (Google Drive/Gemini, Slack, Jira or
  Confluence) into a **local anexo** of the brainstorming, referenced by a
  note. Drive brings the full document; Slack, Jira and Confluence bring an
  agent-written **summary** (never the raw text/description). Each source
  asks for a different identifier: Drive takes an optional search or link;
  Slack takes the channel name; Jira, the ticket key or link; Confluence,
  the page title or link. The agent always lists what it found and asks for
  your confirmation before bringing it in. Items shared by colleagues have
  no folder/organization of their own on your account — that is expected,
  they are still accepted.
  **Prerequisite:** the terminal agent must already have that service's
  connector (Drive, Slack, Jira, Confluence) configured/authenticated —
  Loro does not manage those credentials.
- **Presentation** and **artifact** are built-in habilidades that generate
  material (a markdown deck, a diagram, a script, a spreadsheet) from a
  brainstorming or a context — always into `anexos/` (no folder of its own
  for presentations), and pointing at a specific note automatically links
  it there.
- **Built-in habilidades** (sync, presentation, artifact) can be **edited**
  but never deleted. **Custom habilidades** are skills you author yourself —
  they become real slash-commands (`/habilidade-name`) as soon as they
  exist. Two ways to create one, from the **＋** on the sidebar's
  "habilidades" section: **"new habilidade (AI)"** — describe what it
  should do and the AI writes the skill — or **"import existing skill"** —
  paste the content of a skill you already have. Every listed habilidade
  (in the sidebar) has a **⋯** menu with **use**, **edit** (opens the raw
  file), **ask the AI** (evolve it, preserving what already works) and
  **delete** (custom ones only).
- In the sidebar, the icon tells the origin: **🧩 puzzle piece** = built-in,
  **★ star** = custom (the **📖 book** marks the section and the habilidade
  controls, like Claude's own skills icon). Click the "habilidades" section
  title to **collapse/expand** the whole list (the ▾/▸ caret shows the
  state).

## Highlight, comment, and act on an excerpt

In any acervo markdown — a meeting transcript, a context, a note — **select a
passage** with the mouse and a small floating tool appears with five actions:

- **✎ highlight** — marks the passage (evidenced, like underlining in real
  life). Click the highlight afterwards to **✕ remove** it.
- **💬 comment** — attaches a comment to that passage. The highlight gains a
  stronger underline and every comment in the document is gathered in a
  **"💬 comments"** panel just below the text (each row jumps back to its
  passage).
- **? ask** / **✦ analyse** — runs the habilidade over that passage only: it
  is highlighted and handed to the agent **as evidence**, which focuses its
  analysis/answer on it.
- **➤ Slack** — sends a question about the passage to a **#channel** or
  **@person** on Slack (e.g. "we're in a brainstorm, I need your help with
  this"). The **terminal agent** talks to Slack with its own connector — Loro
  never holds a credential, and nothing is sent without your confirmation.

Highlights and comments live in a file beside the document
(`<doc>.anotacoes.json`) and **travel with the acervo** — they never touch the
original text or any log. If a document is heavily edited and a highlighted
passage can no longer be found, it is not lost silently: it shows up as an
**"orphan excerpt"** in the comments panel.

## Contexts have anexos too

Every context has its own **anexos/** folder, always visible in the tree —
with **＋ new note** (writes a note born inside the context) and **＋ from
computer** (file picker). Unlike brainstorming anexos, a context's anexos
are **versioned with it** (they flow through version/propose change
normally).

## Queue → generate context

- Check the **files** of a brainstorming (a meeting → its analyses, notes,
  attachments) and **send to queue** — each file becomes its own queue
  item (multi-select sends them all). The brainstorming's ⋯ menu has **"send
  everything → queue"** to send them all at once. (You can also drop `.md`/`.txt`
  files straight into the queue.) The raw meeting transcript never goes (BR-8).
- **▶ generate context** runs `/loro-context` in the terminal Claude, which
  structures the material into `contextos/<c>/context.md` (+ CHANGELOG).
- Each `context.md` opens with a **Summary** (1 line per section + `D-…`/`H-…`
  IDs), regenerated on every update — it keeps reading cheap for people and
  agents; decisions and hotspots get stable, searchable IDs.
- With an **empty** queue the button warns and does not run: there is nothing
  to generate from.
- The **"salvar anexos referenciados no contexto"** checkbox (optional, check
  it before generating) copies the processed items' anexos into
  `contextos/<c>/anexos/` — unchecked, anexos stay only in the brainstorming.

## Version and propose change (RFC = PR)

- **⎇ (branch)** shows the current branch; click it to switch branches or
  create a new one. Knowledge changes are **always born on an `rfc/…` branch**
  — main is protected.
- **version** syncs main with the remote (when there is one), creates/reuses
  the `rfc/<slug>` branch and commits your local changes. Offline? The flow
  stays local and the app tells you.
- **propose change** publishes the branch and opens the Pull Request (the
  RFC). The context owners (CODEOWNERS) review it; merging makes the proposal
  official.
- Switching branches with unversioned changes is blocked — version first.

## Ask the knowledge base

- On the Overview, the **📖 executar habilidade** button opens the full
  habilidade list — **perguntar ao acervo** is one of them (also on the
  palette, `Cmd/Ctrl+Alt+Q`). The question runs via `/loro-ask`; the answer
  anchors on the acervo's `context.md` files and says clearly when the base
  does not cover the topic.
- Next to **propor mudança** there is an **ⓘ** explaining the flow: it
  publishes the `rfc/…` branch and opens the Pull Request (the RFC) for the
  context owners to review.

## FAQ

**Where is my data?** In the acervo folder you chose, and only there. Config
and models live in `~/.loro/`. No content leaves the machine without your
action (running a skill, proposing a PR).

**What goes to the cloud?** Nothing, by default. "Propose change" pushes the
branch to your remote repository; the Claude skills read the local base first
and state when they consult anything external.

**Can I have several projects?** Yes — the ◆ selector at the top of the
sidebar switches between acervos and creates new ones.

**Why is "generate context" disabled?** The queue is empty. Send files from a
brainstorming (or drop files into the queue) first.

**Claude does not open in the terminal.** Check that the CLI is installed
(`claude` on PATH) and that an acervo is configured. The app tells you when it
cannot open it.

**How do I resize the sidebar?** Drag the divider between the sidebar and the
editor; with a wide sidebar, files show their date and git state. Double-click
the divider to reset.

**A tab showed another file's content.** That was an old editor defect, now
fixed — if it ever happens again, open an issue with the steps.

**Which language is content generated in?** The language you chose when
creating the acervo (pt-BR or English) — the whole UI follows it. You can
switch later in the gear (⚙); an acervo may hold documents in both languages
if you switch. The on-disk folders (`reunioes/`, `notas/`, `anexos/`,
`contextos/`) stay Portuguese regardless of language.

**What is a "custom habilidade"?** A skill you author yourself — either by
describing what it should do (the AI writes it) or by importing one you
already have. It becomes a real slash-command (`/habilidade-name`) and shows
up in the sidebar's "habilidades" section; run it via a brainstorming's or
meeting's ⋯ menu ("executar habilidade…").

**Can I delete a built-in habilidade (sync, presentation, artifact)?** No —
you can edit it, but not delete it. Only custom habilidades (the ones you
create) can be deleted.

**What does "auto mode" actually do?** It's the "Automatic" usage template
(chosen at creation, the default). With it, the loop can create a new context
or decide which one to assign something to, on its own, while processing the
queue. With any other template (or after turning it off in Settings), it
never creates anything new by itself — it leaves the item pending in the
queue and reports that it needs your manual decision. It never affects
assigning to a context that already exists.

**Why don't a meeting's notes show up right away?** They're
collapsed by default so the sidebar doesn't grow too large — tap the ▸ arrow
next to the meeting to open it.
