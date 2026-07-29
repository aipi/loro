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
2. **Usage template** — pick a ready-made template (Sales, Engineering,
   Product & management, Learning, Education, Hiring, Healthcare) or the
   Generic (blank) one. A template prefills the contexts (still editable),
   appends the vertical's rules to `AGENTS.md`, seeds the queue guide and
   sets the `context.md` mold of every context (sections vary per vertical —
   sales talks pipeline and commitments, healthcare talks practices and
   protocols).
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
4. **Dependencies** — Loro warns when whisper (transcription) or a voice model
   is missing, and installs them from the banner using the embedded terminal.
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
- Inside it (expand the brainstorming in the sidebar): **＋ new note** to
  write, and **● record meeting** to record a **meeting** tied to the topic
  (also in the palette `Cmd/Ctrl+Shift+P` → "nova reunião").
- **✦ AI note** (the brainstorming's ⋯ menu) creates a note from your
  request; **✦ ask the AI** (a note's/analysis' ⋯ menu **and at the top of
  the file viewer**) applies a request to the existing content — the AI
  evolves it, never erases.
- The **analyse**, **ask…** and **view report** actions live in the
  meeting's `reuniao.md` tab and also in the meeting's **⋯** menu in the
  sidebar; they enable once the meeting ends (analyse fills the report).
- In a meeting: mark **questions/decisions/investigations** while people speak
  (via the palette `Cmd/Ctrl+Shift+P` or the buttons); then run **analyse** so
  Claude fills in the meeting report.
- Nothing in a brainstorming is versioned or leaves the machine.
- **⇄ sync meeting** attaches an external meeting note (for now, Gemini notes
  on Google Drive) as a reference on an acervo note — only title, link and
  date; the document's content is never read, downloaded or pasted. It runs
  `/loro-sync drive <topic>` in the terminal, which lists candidates (by the
  "Anotações do Gemini" title pattern + "Meet Recordings" folder, or by being
  shared by someone else) and asks for your confirmation before attaching.
  The button opens an optional **search or link** field: leave it blank for a
  broad search, type a title keyword (e.g. the meeting's name) to narrow it,
  or paste the Drive document's link to skip the search entirely. Meetings
  shared by colleagues have no folder of their own in your Drive — that is
  expected, they are still accepted by the owner criterion.
  **Prerequisite:** the terminal agent must already have the Google Drive
  connector configured/authenticated — Loro does not manage that credential.

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

- **ask the knowledge base** opens Claude in the embedded terminal and sends
  your question via `/loro-ask`; the answer anchors on the acervo's
  `context.md` files and says clearly when the base does not cover the topic.

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

**Which language is content generated in?** The interface language active at
generation time. An acervo may hold documents in both languages if you switch.
