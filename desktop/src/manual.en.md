# Loro Manual

_Loro captures your speech and texts locally and turns everything into a
per-context knowledge base — private, versionable and reviewable. No audio or
text leaves your machine without an explicit action from you._

## The flow in one sentence

**Brainstorming → Queue → Context**: you gather raw material (meetings, notes)
in a brainstorming; you select what matters and send a report to the queue;
"generate context" asks the terminal Claude to distill the queue into
`contextos/` — the official source of truth, versioned in git.

## First steps

On first launch a **welcome modal** sums up the main features (flow,
recording, templates, agent, AI and shortcuts) — reopen it anytime via the
palette: `Cmd/Ctrl+Shift+P` → "Loro tour".

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
5. **Language** — in the gear (⚙), "interface language" switches pt-BR/English.
   Everything the app **generates** (reports, meeting documents, contexts) is
   born in the active interface language.

## Record and transcribe

- **● (record)** opens the recording dialog asking **where to save**: a
  brainstorming (it becomes a meeting tied to the topic) or a "one-off
  transcription" (the text stays in the live panel to save/discard at the
  end). The global shortcut is `Cmd/Ctrl+Alt+Space`.
- Every palette command (`Cmd/Ctrl+Shift+P`) has a `Cmd/Ctrl+Alt+<key>`
  shortcut, shown next to the command in the palette itself.
- **Sources**: microphone, system audio (requires BlackHole — the app guides
  the install) or **meeting** (mic + system together; transcription happens at
  the end, with better fidelity).
- Audio is **transient**: used to transcribe, then discarded. The privacy
  indicator in the bar shows the state ("not recording" / "records audio").

## Brainstorming (the non-versioned world)

- The **＋** in the section header creates a brainstorming (a private space
  for a topic); the contexts section's **＋** creates a context.
- Inside it (expand the brainstorming in the sidebar): each folder has its
  own creation action at the top — **notas** → **＋ new note**; **reuniões**
  → **● record meeting** (also in the palette `Cmd/Ctrl+Shift+P` → "nova
  reunião"); **anexos** → **⇄ sync** (brings from Drive/Slack/Jira/
  Confluence) and **＋ from computer** (opens the file picker and copies a
  `.pdf`/`.xlsx`/image you already have into the topic's anexos).
- **✦ AI note** (the brainstorming's ⋯ menu) creates a note from your
  request; **✦ ask the AI** (a note's/analysis' ⋯ menu **and the right-side
  rail of any open file**) applies a request to the existing content — the
  AI evolves it, never erases.
- **Update index (digest)** (the brainstorming's ⋯ menu) runs the
  `/loro-digest` habilidade: it reads **all** of the topic's material (meeting
  reports, notes and attachments) and (re)writes `indice.md` — the main
  markdown — with an **overall summary**, the **key points & highlights**, an
  **index** linking every material, and the **references** (the panel at the top
  of the file). You trigger it and it rewrites the index from scratch (it never
  reads the raw transcript or audio — only the reports and notes). When new
  material appears since the last index, `indice.md` shows a subtle banner at
  the top ("N new items — update index") with a button to regenerate.
- **⋯ menu on any file** (note, attachment, misc, meeting note): beyond
  **rename** and **delete**, it offers **⇄ move to…** (pick the destination
  folder — misc, or any brainstorming's notes/attachments folders) and
  **⧉ copy path** — **relative** (portable, the format used by `acervo://`
  references) or **absolute** (the full on-disk path, handy to open in
  Finder/terminal). A same-named file at the destination is never overwritten.
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
- The **analyse**, **ask…**, **view report** and **send to queue** actions
  live in the meeting's **⋯** menu in the sidebar. **Ask…** already works
  while the meeting is still recording; the other three enable once the
  meeting ends (analyse fills the report).
- The meeting's `reuniao.md` tab shows, instead of fixed buttons, a single
  **habilidade dropdown** ("o que fazer com esta reunião") — pick any
  habilidade (including analyse/ask) and run it against the open meeting.
  Unrestricted: every habilidade shows up there, built-in and custom.
- In a meeting: mark **questions/decisions/investigations** while people speak
  (via the palette `Cmd/Ctrl+Shift+P` or the buttons); then run **analyse**
  (⋯ menu) so Claude fills in the meeting report.
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

- Select the parts of a brainstorming and **send the report to the queue** (or
  drop `.md`/`.txt` files straight into it).
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

**Why is "generate context" disabled?** The queue is empty. Send a
brainstorming report or drop files into the queue first.

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
