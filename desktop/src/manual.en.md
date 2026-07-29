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

1. **Create the knowledge base** — on first launch the wizard asks for a name,
   the folder to generate into and the initial contexts (e.g. `product`,
   `engineering`). Check "version with git" to enable the review flow
   (recommended).
2. **Usage template** — pick a ready-made template (Sales, Engineering,
   Product & management, Learning, Education, Hiring, Healthcare) or the
   Generic (blank) one. A template prefills the contexts (still editable),
   appends the vertical's rules to `AGENTS.md` and seeds the queue guide.
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

- **● (record)** starts live microphone transcription; the global shortcut is
  `Cmd/Ctrl+Alt+Space`. The live panel shows text as you speak.
- **Sources**: microphone, system audio (requires BlackHole — the app guides
  the install) or **meeting** (mic + system together; transcription happens at
  the end, with better fidelity).
- Audio is **transient**: used to transcribe, then discarded. The privacy
  indicator in the bar shows the state ("not recording" / "records audio").

## Brainstorming (the non-versioned world)

- **＋ new brainstorming** creates a private space for a topic.
- Inside it: **＋ new note** (first row of the block) to write, and ● to record
  a **meeting** tied to the topic.
- In a meeting: mark **questions/decisions/investigations** while people speak
  (via the palette `Cmd/Ctrl+Shift+P` or the buttons); then run **analyse** so
  Claude fills in the meeting report.
- Nothing in a brainstorming is versioned or leaves the machine.

## Queue → generate context

- Select the parts of a brainstorming and **send the report to the queue** (or
  drop `.md`/`.txt` files straight into it).
- **▶ generate context** runs `/brain-context` in the terminal Claude, which
  structures the material into `contextos/<c>/context.md` (+ CHANGELOG).
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
  your question via `/brain-ask`; the answer anchors on the acervo's
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
