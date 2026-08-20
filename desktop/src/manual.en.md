# Loro Manual

_Loro captures your speech and texts locally and turns everything into a
per-topic knowledge base — private, with history and reviewable. No audio or
text leaves your machine without an explicit action from you._

## The flow in one sentence

**Ideas → To organize → Knowledge**: you gather raw material (meetings, notes,
attachments) inside an **idea**; you select the **files** that matter and each one
lands in **to organize** as itself (one item per file); **Turn into knowledge →**
asks the agent to distill all of it into **knowledge topics** — the official
source of truth, with a version history.

## The screen, at a glance

Every screen shares one anatomy:

```
HEADER 54px — [project ⌄] [Home · Organize · Knowledge · Review] ··· [Record] [✦ AI]
SIDEBAR      │ TABS (only when a document is open) │ PANEL 330px
250px or 60px│ CONTENT                             │ Document · Chat · ⟳ Loops · Terminal
```

- **The four destinations** live in the header: **Home** (what do you want to
  keep today), **Organize** (what you captured that has not become knowledge
  yet — the amber number is the count), **Knowledge** (the team's official
  topics) and **Review** (what you changed and have not saved, and what the team
  proposed and is waiting for someone to read — the amber number is how many
  reviews are waiting on you).
- **Record** is the red header button; while recording it becomes **Stop**, and
  recording continues if you switch tabs — a `recording · mm:ss` pill in the
  header takes you back.
- **If you listen through speakers**, the mic hears the others back, and the
  same sentence reaches both tracks. Loro drops the copy by itself, and always
  the **mic** one: sound leaks from the speaker into the mic and never the other
  way around, so the others' speech is never labelled as yours. To do that it
  waits a few seconds for the system track before writing your speech — that is
  why your text sometimes shows up slightly later. To kill the leak at the
  source, turn on **cancel speaker echo** in Settings → Capture, at the cost,
  stated there, of your voice coming out quieter. With headphones, leave it off.
- **The text lands in paragraphs**, one per stretch of continuous speech, stamped
  with the time that speech actually began — and a pause starts a new paragraph.
  The time is counted from the moment recording actually began: in a meeting the
  system-audio capture starts before the screen appears, so the clock may open
  with a few seconds already run — that is time already recorded, not a glitch.
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
- The sidebar sections (**ideas**, **to organize**, **knowledge**, **loops** and
  **AI skills**) **collapse**: click the heading. With many topics that is what keeps the tree
  navigable.
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
- **Drag a file from Finder/Explorer into the chat** (image, audio, PDF, anything):
  its **path** is pasted into the field at the cursor, for the agent to read the
  file as it answers. Several files at once paste every path. The file is not copied
  and does not enter the project — only the path is written, and you go on typing. Same
  in the **terminal**: there the path is typed onto the line, quoted if it needs to
  be, and **nothing runs** — the Enter is yours.
- The conversation **continues** from one question to the next. **restart** starts
  over.
- `sonnet · high ⌄` is a single control: pick the **model** and the **effort**
  (how much the agent thinks before answering).
- The ↑ becomes **■** while answering — click it to stop the turn.
- Every step the agent took (a tool it used) **opens**: click it to see the
  request and the response. A failed step opens on its own.
- If the agent **was not allowed to finish**, an amber block appears:
  **Allow everything and retry** — which switches what the chat may do to
  *everything, without asking*, and holds for the next times too — or
  **Continue in the terminal**, where it can ask you step by step. Nothing was
  changed until you choose.
- **Where AI skills run** is your choice: **Settings → AI and terminal**.
  *In the chat*, the answer stays in the conversation; *in the terminal*, you
  follow each step and can step in. It applies to everything — analysing a
  meeting, asking the project, running an action from a ⋯ menu.
- **What the chat may do** is also your choice (**Settings → AI and terminal**).
  The chat cannot stop and ask mid-action, so it ships able to act: *read and
  edit the project* covers analysing a meeting and writing notes; *everything,
  without asking* also allows external connectors (Slack, Drive…) and paths
  outside the project folder.

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

1. **Create the project** — on first launch the wizard shows every
   field at once (nothing hides behind "advanced options"): name, usage
   template with the initial topics right next to it (e.g. `product`,
   `engineering`), folder (the default one comes pre-filled; the ⓘ details
   what will be stored in it), language, color and the AI agent. Leave "keep
   a version history" checked to enable the review flow (recommended).
2. **Usage template** — the first option is **Automatic** (default): the agent
   creates and assigns topics on its own when it organizes, so
   you don't need to define topics now (you can turn it off later in
   Settings). The other options are ready-made templates (Sales,
   Engineering, Product & management, Learning, Education, Hiring,
   Healthcare) or the Generic (blank) one — with those, you define the
   topics and the agent won't create new ones on its own. Each template
   prefills the topics (still editable), appends the vertical's rules to
   `AGENTS.md`, seeds the agent's instructions and sets the mold of every
   topic's knowledge document (sections vary per vertical — sales talks
   pipeline and commitments, healthcare talks practices and protocols). Each option's
   explanation appears right below it when selected.
   "duplicate to customize" copies any template into `~/.loro/templates/`,
   where you edit the files and it shows up in the wizard. Templates that
   touch personal data (Sales, Hiring, Healthcare) ship minimization rules —
   Healthcare warns explicitly: health data is sensitive and the base never
   replaces the medical record.
3. **AI agent** — the "AI agent (command)" field sets which CLI the embedded
   terminal uses for this project: `claude` (default), `gemini`,
   `ollama run llama3`… The project is just files + convention (`AGENTS.md`),
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
   Everything the app **generates** (analyses, meeting documents, knowledge) is
   born in the active interface language.
6. **Version** — the footer of Settings (⚙) shows the installed version
   (e.g. `v0.8.0`), so you can tell at a glance whether an update landed.

## Record and transcribe

- **● (record)** opens the recording dialog asking **save to**: an idea (it
  becomes a meeting tied to it) or **one-off transcription (save at the end)** —
  the text stays in the live panel to save/discard when you stop. The global
  shortcut is `Cmd/Ctrl+Alt+Space`.
- Every palette command (`Cmd/Ctrl+K`) has a `Cmd/Ctrl+Alt+<key>`
  shortcut, shown next to the command in the palette itself.
- **Sources** (Settings → Transcription → *source*): **microphone**, **system
  audio** (requires BlackHole — the app guides the install) or **my voice +
  system audio** (the meeting: both tracks together; transcription happens at
  the end, with better fidelity).
- Audio is **transient**: used to transcribe, then discarded. The privacy
  indicator in the bar shows the state ("not recording" / "records audio").

## Ideas (the world with no version history)

- **Write a note** (on the Home screen) opens a **blank** markdown right away:
  you write first and, on save, you pick the title and where the note lives — an
  existing idea or a knowledge topic. Until you save, nothing is written
  to disk.
- The **＋** next to **ideas** creates an idea (the button is called "New
  idea"): a private space for a subject. The **＋** next to **knowledge**
  creates a topic (the button is called "New topic").
- Inside it (expand the idea in the sidebar): each folder has its
  own creation action at the top — **notes** → **＋ new note**; **meetings**
  → **● record meeting** (also in the palette `Cmd/Ctrl+K` → "new
  meeting"); **attachments** → **⇄ sync** (brings from
  Drive/Slack/Jira/Confluence) and **＋ from computer** (opens the picker and
  copies a `.pdf`/`.xlsx`/image you already have into the topic's attachments).
- **✦ AI note** (the idea's ⋯ menu) creates a note from your
  request; **✦ ask the AI** (a note's/analysis' ⋯ menu **and the right-side
  rail of any open file**) applies a request to the existing content — the
  AI evolves it, never erases.
- **⋯ menu on a meeting**: beyond rename and delete, **⇄ move to…** takes the whole
  meeting — transcript, analyses and generated material — into another
  idea — available once the meeting has finished, like analysing and
  sending to organize. You can also drag the meeting by its icon onto the destination's
  **📁 reuniões** header. A meeting with the same name at the destination is never
  overwritten.
- **⋯ menu on any file** (note, attachment, misc, meeting note): beyond
  **rename** and **delete**, it offers **⇄ move to…** (pick the destination
  folder — misc, or any idea's notes/attachments folders) and
  **⧉ copy path** — **relative** (portable, the format used by `acervo://`
  references) or **absolute** (the full on-disk path, handy to open in
  Finder/terminal). A same-named file at the destination is never overwritten.
  **Copy path** is on the ⋯ menu of **every item in the sidebar tree** — files,
  ideas, meetings, items to organize, topics, folders (attachments) and AI
  skills, plus the sources.
- **Drag and drop:** drag a file's **icon** (the cursor turns into a grab
  hand) onto a folder header (📁 notes, 📁 attachments or 📁 misc) to move it —
  the same effect as **move to…**, confined to the world of ideas (never
  touches what has a version history). The rest of the row stays click-to-open.
- **Dragging from your computer into the tree:** drop a file from Finder/Explorer onto a
  **folder** in the sidebar — an idea, one of its folders (📁 notes, 📁 attachments), a
  knowledge topic or a **loop** — and it is **filed there: the file is MOVED, and the
  original leaves its folder**, as in any file manager. The receiving folder **lights up**
  while you drag, and the notice afterwards says where it went and where it came from
  (there is no undo — to correct it, use **move to…** in the row's ⋯). Dropping on the
  **to organize** area still **copies**: there the gesture means «hand this to the AI», and your
  original stays where it was. A file already inside the project is refused with a notice —
  moving within the project is **move to…**. And a credential in a file headed for the
  **knowledge** (which is versioned) is refused before anything moves.
- **Right-side actions rail:** opening any note/document shows separate
  action cards on the right — **skill** (a dropdown with friendly
  names; the selected skill's description stays visible right below
  it, and **▶ run** runs it against the open file), **ask the AI…**,
  and **Save version** (when the file belongs to a knowledge topic). Same
  pattern everywhere these actions exist — meeting, regular document, project
  header.
  In **edit mode** the editor fills the whole panel and the rail is hidden;
  the actions stay available in view mode.
- **Formatting bar in edit mode:** above the editor there are buttons for
  **bold** (⌘B), *italic* (⌘I), strikethrough, headings (H1/H2/H3), bulleted
  list, checklist, numbered list, quote, code, link (⌘K), table, code block
  and horizontal rule. They write the markdown syntax at the cursor (or wrap
  the selection) and undo it when you click again on text that is already
  formatted — the file stays readable markdown, so the git history shows only
  what you actually changed. The same bar appears in the editor for the items
  in **to organize** and for the agent's instructions, where **⌘S** saves.
- **✦ analyse**, **? ask…** and **send to organize →** live in the meeting's
  **⋯** menu in the sidebar. **ask…** already works while the meeting is still
  recording; the other two enable once the meeting ends. **send to organize**
  sends the meeting's **analyses** (whatever is in `notes/`) — the raw
  transcript never goes. A meeting nobody analysed has nothing to send, and the
  menu says so instead of failing on click.
- The meeting's `meeting.md` tab shows, instead of fixed buttons, a single
  **skill dropdown** ("what to do with this meeting") — pick any skill
  (including analyse/ask) and run it against the open meeting.
  Unrestricted: every skill shows up there, built-in and custom.
- In a meeting: use **✎ Mark moment** (`Cmd/Ctrl+Alt+M`, or the button above the
  transcript) to anchor the instant something important was said — one marker,
  no kind to choose mid-sentence; then run **analyse**
  (⋯ menu) so Claude writes the analysis into `notes/`. When the recording ends
  the app opens the transcript and **offers** to analyse in one click — a
  suggestion, never a run, and it goes away if you ignore it.
- Nothing inside an idea enters the version history or leaves the machine.
- A meeting's **notes** (analyses, answers and any document an AI skill
  produces) are **collapsed by default** in the sidebar (tap the ▸ arrow next
  to the meeting to open) — keeps the list from growing huge once you've
  analysed several meetings. Everything a skill produces about the meeting
  goes into its **notes/** folder (no more separate investigations/answers
  folders).
- Every idea has exactly three folders, visible in the sidebar as
  collapsible groups with a folder icon (📁 **meetings**, 📁 **notes**,
  📁 **attachments**) — on disk `meetings/` (every meeting is born there),
  `notes/` and `attachments/` (a presentation is just one kind of attachment — no
  folder of its own). `attachments/` is fed by an AI skill (sync, presentation,
  artifact) or by dropping a file straight into the real folder on disk.
- With many ideas, a search box appears above the list (past 8) —
  filters by name; with no search, it shows the most recent + "see all".

## AI skills

AI skills are agent actions — some ship ready-made (built-in), others you
create. They no longer live on the Overview: run one from an idea's **⋯**
menu → **"run skill…"**, from the **"run skill…"** button at the top of
**any markdown file's** viewer, or from the skill dropdown on an open
meeting. Always a compact menu/control — each item's description only shows
on hover, so it doesn't clutter the screen once there are many.

When you run a skill with no document open (⌘K, from Home), the sheet asks
**where** it should act: a picker with the ideas and knowledge topics the project
already has. Opening the skill from inside a document fills the target in with
that document.

- **Sync** brings an external item (Google Drive/Gemini, Slack, Jira or
  Confluence) into a **local attachment** of the idea, referenced by a
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
- **Presentation** and **artifact** are built-in skills that generate
  material (a markdown deck, a diagram, a script, a spreadsheet) from an idea
  or a knowledge topic — always into `attachments/` (no folder of its own for
  presentations), and pointing at a specific note automatically links it
  there.
- **Built-in skills** (sync, presentation, artifact) can be **edited**
  but never deleted. **Custom skills** are skills you author yourself —
  they become real slash-commands (`/skill-name`) as soon as they
  exist. Two ways to create one, from the **＋** on the sidebar's
  "AI skills" section: **"new skill (AI)"** — describe what it
  should do and the AI writes it — or **"import an existing skill"** —
  paste the content of a skill you already have. Every listed skill
  (in the sidebar) has a **⋯** menu with **use**, **edit** (opens the raw
  file), **ask the AI** (evolve it, preserving what already works) and
  **delete** (custom ones only).
- In the sidebar, the icon tells the origin: **🧩 puzzle piece** = built-in,
  **★ star** = custom (the **📖 book** marks the section and the skill
  controls, like Claude's own skills icon). Click the "AI skills" section
  title to **collapse/expand** the whole list (the ▾/▸ caret shows the
  state).

## Loops (work the AI repeats at a rhythm)

A **loop** is standing work: you write ONCE what you want done — *"read this
week's ideas and write what has not been decided yet"* — say at what rhythm, and
Loro runs it with the AI on that rhythm. What comes out is a file, in the folder
you chose, that opens and reads like any other document.

Loops live in the **LOOPS section of the sidebar**, between *knowledge* and *AI
skills* — a loop can belong to the whole project, so it does not live inside one
idea. Create one with the section's **＋**.

**The two tracks, and the echo.** A meeting captures **your voice** (microphone) and **the
machine's audio** (the other participants) — what the analysis reads as «you» and «the
others». If you listen **through speakers**, the mic hears the machine back and the same
speech arrives on both tracks. Loro detects that and offers both exits on the spot: **record
only the system** (one track, no echo, no microphone permission asked — your voice stays out)
or **cancel the echo** (both tracks stay, but macOS swaps the machine's audio path and your
voice comes out quieter). Whatever you pick applies **from the next meetings on**, and both
switches live in **Settings → Capture**. With **headphones there is no echo** — then keeping
both is best.

**The price, said up front:** a loop runs the AI **while the app is open**. With
the app closed it does not run — and the loop's screen counts how many runs it
missed, catching up at most **once** when you come back. Every cycle runs with
«read and edit the project»; «everything, without asking» is refused for a cycle
that happens without you.

**Creating is the same screen as editing.** Name, the skill it cites (optional),
instruction, **model**, **effort**, scope, rhythm, destination and the **brakes**:

- **may create, per cycle, up to** N files · **may run, per day, up to** N times ·
  **turns itself off on** a date. These are **brakes, not targets**: hitting one
  ends the cycle, and the screen says which. They exist so a forgotten loop does
  not spend the AI with nobody watching. The defaults for a new loop live in
  **Settings → Loops**.
- **The model and the effort** belong to this loop: each cycle is one AI turn like
  the Chat's, and a bigger model (or a bigger effort) costs more — at the rhythm you
  chose above. Left on **«the agent's own default»**, the cycle runs with whatever
  the project's agent already uses. Unlike the scope, editing DOES reopen this — and
  the loop's screen says what it runs with (*«runs with opus · very high»*).
- **You do not declare permissions up front** — and you do not need to. A cycle can
  already read and edit the project. When one needs something **outside** it (a
  connector, a web search), it stops, and the request shows up in the **⟳ Loops →
  REQUESTS** tab, naming the tool and which loop hit it: **allow** or **no**. Allowing
  applies to the **next cycles of every loop in this project** — once granted, granted.
  It does not apply to the **Chat**, which has its own control in *Settings → AI*. «No»
  closes the door: cycles stop trying it and the request does not come back.
  What has been decided is read and undone in **Settings → Loops**, and each loop's
  screen shows the same under the **may use** button.
  *Never* granted to a cycle: «everything, without asking» and **running commands** — a
  cycle runs no commands at all, which is why it cannot version, push, or step outside the
  project's folder. That is a lock, not a request made of the agent.
  *Two honest caveats:* allowing a connector allows what that tool does (Loro cannot tell,
  from a name, what only reads from what writes — the cycle's instruction forbids sending,
  but that is a rule told to the agent, not a lock); and what a connector returns can
  bring **other people's personal data** into the project, which is versioned and shared.
- **The scope** is **what** the loop works on, and it has four shapes: **the
  project**, **one idea**, **one folder** (type the path or pick one of the
  project's folders) or **one knowledge topic**. Pointed at a folder or a topic, the
  cycle reads **only what is in there — nothing outside**. It is declared **once, at
  creation** — the only field editing does not reopen; re-pointing it means another
  loop. If the folder it points at stops existing, the loop reads **blocked** and
  the screen names it.
- **The destination** can be the loop's folder, an idea's attachments, or **the
  knowledge**. In that last case the cycle **proposes**: the change lands on your
  working draft and shows up in **Review** — nothing becomes official without you.

**The seven states**, and what each one says:

| State | What it means |
|---|---|
| **off** | it exists and does nothing — you turned it off, or it arrived that way from a plugin |
| **on** | it will run, and the screen says when |
| **running** | a cycle is running now (the **⟳ Loops** panel shows the steps) |
| **waiting for you** | its turn came and you are using the AI — it never cancels your conversation |
| **blocked** | it is on and **cannot** run; the screen says why (no agent configured, the skill it cites was deleted, the scope's folder no longer exists, a tool was not allowed — and then the screen offers to allow it —, another window is running this loop) |
| **failing** | it failed a few times in a row and is backing off; after five it turns itself off and says so |
| **expired** | it lived its declared span: it ran one last time and turned itself off |

**Where you see that something is happening:** on the sidebar row (the state and
the next run), in the **header** (a teal mark while a cycle runs — the same idea
as the recording seal, but never red and never blinking; clicking it opens the
tab), and in the **⟳ Loops tab of the ✦ AI panel**, which lists the cycles and
shows one cycle's steps with **■ stop this cycle**. A cycle **does not take over
your chat**: the Chat stays yours, and each cycle is the project agent's own turn.

**The loop's screen** shows the rhythm, a timeline of the last cycles, the
**effective instruction** and the **cycles**. Each cycle says when it ran, how
long it took, what it produced and the outcome — never the produced text.
Consecutive quiet cycles collapse into a single row (`×2 · nothing new`), and a
skipped cycle (because the previous one was still running) is recorded rather
than turned into silence.

**A cycle has three ways out, and none of them is silence without explanation.** It opens
what it produced before and then: **updates** that document with whatever is new (the
preferred one — rather than creating another like it beside it), **writes a new document**,
or answers *nothing new* when there is nothing to add and nothing to correct. On the
**first** cycle the third way does not exist: with nothing of its own to compare against, it
produces what the instruction asks for.

**In the step-by-step (⟳ Loops tab) every step expands**: the request and the **response**.
A step marked **!** shows why — it may be an ordinary error (a path that does not exist) or a
missing permission; in that second case it **says** it is a permission and carries the
*allow* button right there.

**When you run it yourself, the screen says what happened** — how many files, or *nothing
new*, or why it failed. An automatic cycle stays quiet on purpose (the header mark is its
signal). And **every history row expands**: inside are the files, the steps and the time —
and on a quiet cycle, what «nothing new» means.

**Adjust by talking:** at the bottom of the loop's screen there is a field. What
you write there joins the instruction as a dated line (*"from 18/08: ignore
cancelled meetings"*) and applies from the **next** cycle — that is what keeps the
loop readable after five corrections instead of becoming a black box.

**Where what it produced shows up:** in the **LOOPS section of the sidebar**, by opening
the caret beside the loop's name — the files of its destination folder are there, and each
opens like any document — **with the same ⋯**: ask the AI, rename, **move to** (an idea, say),
**copy path** (relative or absolute) and **delete**. When the destination is the knowledge, the row says the change is in
**Review**. A new file shows up on its own, with nothing to reload.

**What a loop never does:** save a version, send for the team's review, approve,
push, or send a message outside. Those are the person's acts.

## Plugins (ready-made skills, topics and loops)

A **plugin** is a folder that brings ready-made things into the project: skills,
starting topics and loops. It is the same format as Claude Code's plugins, so a
package written for it works here.

Install one with the **＋ of the "AI skills" section → install plugin…** (or the
loops ＋). Before installing, the sheet shows what the plugin brings and what the
**triage** found in its files: a credential **blocks** the install (the project is
versioned and goes to git), a CPF **warns** and you decide.

- **Installing is a change**, not a publication: the files land in the project and
  show up in **Review** like any other change of yours. Nothing is sent.
- **A plugin's loops arrive off.** Turning one on is always your act.
- **Nothing is overwritten.** A file that already exists is skipped, and the sheet
  says how many were.
- **Loro does not install plugins that run commands** on your computer (`hooks/`,
  `bin/`, MCP servers). It recognises that kind and refuses **naming it** — only
  skills, topics and loops, which are instructions.
- In the sidebar, a skill that came from a plugin shows the **plugin's name**
  beside it — "where did this come from" is the question that matters when a skill
  misbehaves.
- **Settings → Plugins** lists what is installed (name, version, origin, what it
  brought) with a **⋯** for *see what it brought* and *remove*. Removing subtracts
  only what the plugin brought: **a file you edited afterwards stays**, and the
  screen says which.

## Extensions (a new screen, built from what the project already has)

An **extension** goes one step further than a plugin: besides bringing skills, it
can draw a **screen** inside Loro. That screen is not a file — it is built on the
spot from what your own project already knows (the open points in your knowledge,
for example). You open it from the **EXTENSÕES** section of the sidebar.

Install one with the **＋ of the "extensions" section** (or with **Settings →
Extensions → install extension…**). Point at the extension's folder — the one with
`loro.json` and `.claude-plugin/plugin.json` inside. **Loro downloads nothing and
builds nothing:** the source is always a folder on your computer.

Before installing, the sheet states everything the extension declared — including
what Loro **does not do yet**. A request this version does not implement is named
out loud instead of being dropped in silence.

- **An extension may bring a program.** If it does, the sheet says which command
  it is, and it **does not run by itself**: you look at the screen, click
  **start**, and it stops when you click **stop** or when Loro closes. While it is
  stopped the screen says stopped — never the opposite.
- **Nobody starts a program on your behalf.** An extension's record is kept with
  the project, so it can arrive in somebody else's change. The first time you click
  **start** on a program **this computer** has never approved, Loro shows the command
  and the arguments that would run, where they came from, and asks. The answer stays
  here — it does not travel with the project — and you are asked again only if the
  command changes.
- **A program runs with your own access.** Loro does not put an extension's program
  in a box: it reaches what you reach on this computer. That is why the question
  above exists, and that is what the sheet says.
- **If it stops answering, you can still stop it.** The row and the screen say «sem
  resposta» — the program is alive and mute, not stopped — and **stop** stays on
  offer. Starting again never leaves two programs behind.
- **An extension with no program simply works.** It shows no start and no stop,
  because there is no process to start.
- **Audio never leaves your machine.** An extension that asks to hear the audio and
  to talk to the network at the same time is **refused at the door**, and the
  screen says why.
- **No credentials.** If the extension declares a setting that asks for a password,
  key or token, the install is refused and **nothing is written**.
- **What it asks for is written down.** Each row's **⋯** has *what it asked for…*,
  where you allow or refuse each item. In this version your answer is **recorded and
  blocks nothing**, and the screen says so — instead of promising a barrier that does
  not exist yet. Loro opens no door for an extension to read your project; what it
  also does not do is isolate that extension's program, and both halves are written
  there.
- **Where the controls are.** Clicking the row opens the screen. The row's **⋯**
  (the same menu in the sidebar and in Settings) has: *open* · *start* or *stop* —
  only when there is a program — · *settings…* · *what it asked for…* ·
  *remove…*. The screen itself also has start and stop, and states the current
  state in words.
- **A repaint never eats what you are typing.** If the extension says its screen
  changed while you are filling one of its fields, Loro waits until you leave the
  field to repaint — the notice is postponed, never lost.
- **Settings** live in the same **⋯**, and each one is stored where the extension
  asked for it: with the project, or with this computer.
- **Settings → Extensions** lists what is installed (name, version, state, where it
  came from). Removing subtracts only what the extension brought: **a file you
  edited afterwards stays**, and the screen says which. You choose whether the data
  it kept here is deleted too.
- If the extension draws something Loro cannot draw, that piece shows up as a
  **named refusal** inside the screen. A piece dropped in silence would be a screen
  lying about what it showed. One exception, stated because it exists: inside a block
  of running prose, an **image** and an outside address are removed with no warning —
  that is content, and this version draws no image at all coming from an extension. A
  link to a file **in this project** is still a link, and clicking it opens the file.

Two worked examples ship in the repository, under `examples/extensions/`: a board
of open points with **no code at all**, and a standard-library Python server that
works both inside and outside Loro.

## Highlight, comment, and act on an excerpt

In any project markdown — a meeting transcript, a topic, a note — **select a
passage** with the mouse and a small floating tool appears with five actions:

- **✎ highlight** — marks the passage (evidenced, like underlining in real
  life). Click the highlight afterwards to **✕ remove** it.
- **💬 comment** — attaches a comment to that passage. The highlight gains a
  stronger underline and every comment in the document is gathered in a
  **"💬 comments"** panel just below the text (each row jumps back to its
  passage).
- **? ask** / **✦ analyse** — runs the skill over that passage only: it
  is highlighted and handed to the agent **as evidence**, which focuses its
  analysis/answer on it.
- **➤ Slack** — sends a question about the passage to a **#channel** or
  **@person** on Slack (e.g. "we're in a brainstorm, I need your help with
  this"). The **terminal agent** talks to Slack with its own connector — Loro
  never holds a credential, and nothing is sent without your confirmation.

**Without a mouse:** the palette (`Cmd/Ctrl+K`) has **Highlight an excerpt…** —
type or paste the exact passage and it gets highlighted. Every highlight is a
control: it joins **Tab** navigation and opens the same actions with **Enter**.
Inside them the **arrow keys** move from action to action, as in every other menu
in the app, and **Esc** closes and hands focus back to the highlight.

Highlights and comments live in a file beside the document
(`<doc>.anotacoes.json`) and **travel with the project** — they never touch the
original text or any log. If a document is heavily edited and a highlighted
passage can no longer be found, it is not lost silently: it shows up as an
**"orphan excerpt"** in the comments panel.

## Knowledge topics have attachments too

Every topic has its own **attachments** folder (`attachments/` on disk), always
visible in the tree — with **＋ new note** (writes a note born inside the
topic) and **＋ from computer** (file picker). Unlike an idea's attachments, a
topic's attachments **enter the version history with it** (they flow through Save version and Send
for team review normally).

## To organize → knowledge

- **Before anything goes in, Loro checks what the file carries.** If it looks
  like a credential (API key, token, private key), the file **does not go in** —
  the project keeps history and goes to git, and what is published cannot be taken
  back. A national ID or a pasted transcript raises a warning instead: you read
  it and decide. The warning names the rule and the line, never repeats what it
  found.
- Check the **files** of an idea (a meeting → its analyses, notes,
  attachments) and use **send to organize** — each file becomes its own item
  (multi-select sends them all). The idea's ⋯ menu has **→ everything to
  organize** to send them all at once. (You can also drop `.md`/`.txt` files
  straight into the list.) The raw meeting transcript never goes (BR-8).
- **Turn into knowledge →** runs the organizing skill in the agent, which
  structures the material inside the topic (its knowledge document + the topic's
  history).
- Each knowledge document opens with a **Summary** (1 line per section +
  `D-…`/`H-…` IDs), regenerated on every update — it keeps reading cheap for
  people and agents; decisions and hotspots get stable, searchable IDs.
- With nothing **to organize** the button warns and does not run: there is
  nothing to generate from.
- The **destination** selector decides where the material lands: *the AI
  decides* or a topic you pick. **keep the attachments too** (optional, check it
  before) copies the processed items' attachments into the topic's attachments
  — unchecked, they stay only in the idea. **adjust instructions** opens what the
  agent must follow before organizing.

## How one topic pulls another

- **You can see where a click goes before clicking.** Inside a document, a jump
  to **another topic** looks like an ordinary name, a jump to a **file in the
  project** looks like a path in machine type, and an address that **leaves for
  the browser** carries a small `↗`.
- **Cited by** is the box right below **References**, at the end of a topic.
  References shows what that topic points at; **Cited by** shows who points at
  it — and in which direction: *receives from this one*, *feeds this one*, or
  *both directions*. Click any row to open the topic that cites it. With nobody
  citing, the box does not appear.
- **Index** — the button is in **Knowledge**, and also in `⌘K`. It lists every
  word the knowledge has already written — the name one topic uses to call
  another, the title of an open point, a decision, a cited code — with the exact
  place of each one beside it. Click a place and it opens right there. **It is
  computed on the spot, every time you open it**: it is not a file, it cannot go
  stale, and nothing is written into your project because of it. `Cmd/Ctrl+F`
  searches inside the list.
- **Knowledge nobody cites** and **Broken links** sit at the end of
  **Knowledge**, and only appear when the problem exists. The first lists topics
  no other topic points at — anyone reading along the links never reaches them;
  the second lists links pointing at a file that does not exist. Each row names
  the topic and carries **open** beside it: for a broken link it opens the
  document **that cites** (that is where the fix goes) and shows the address
  exactly as it was written.
- **The project index and the index of terms sit at the top of Knowledge.** The
  first (`INDEX.md`) lists every topic with a one-line description — it is where
  to start, and where the AI starts. The second (`TERMS.md`) is the list of names
  with the place of each one. Both are files in the project: they open on GitHub
  and in any editor, with no Loro.
- **A project with the old structure asks to be updated before it opens.** Loro
  recognises it and shows one screen with one button: you see the full list of what
  will change before confirming, nothing is deleted, and what you wrote stays as it is.
- **Clicking an entry lands on the word, not at the top of the file.** The
  passage is highlighted for 10 seconds and the view scrolls to it; the mark then
  disappears on its own, leaving nothing behind in the document.
- **The index of terms keeps itself.** It is regenerated when the knowledge
  changes — not when you open the screen — and only rewritten when the content
  actually changed, so it does not clutter your `git status`.
- **A person's name does not belong in the knowledge.** The project is versioned
  and shared, so whoever takes part is described by role (product, business,
  engineering), not by name. That is the project's own rule, and Loro can point
  at what looks like personal data for you to decide.
- **Cited codes (`MM-1147`) become links once you say where they open.** In
  **Settings → Project**, the *where cited codes open* field takes the start of
  your tracker's address (`https://…/browse/`). Without it the code still shows
  in the text, it just is not clickable — Loro does not guess where another
  tool's codes live.

## Review

The **Review** destination is the other half of the product: nothing enters the
official knowledge without someone reading it. It has two halves, and the
sentence at the top follows the one you pick.

### What you changed

- This is what **you** changed and have not saved as a version yet. It works
  **with no internet, no GitHub and no account** — it is your computer's history.
- One card per document, with **new · modified · removed**, the name, the path and
  how much changed (`+6 −2 · 2 passages changed`).
- **Click the card** and the change shows up in your own words: **before** (a
  reddish fill) and **after** (a greenish one). A brand-new document shows as
  **new document**, with its opening. A summary is a summary: if it is long, the
  app says how many lines it left out.
- **See the whole change** opens the exact lines, inside the same card, with line
  numbers. **Unified** (the default) reads like the document, with `−` and `+`
  lines; **side by side** puts the before on the left and the after on the right.
  Where there was no line, the space is hatched. A run between two pieces is
  announced (`⋯ 12 unchanged lines`) — a notice, not a button: those lines did not
  change.
- On a very long change the card draws 400 rows at a time, says how many are left
  (`⋯ … and 500 more lines`) and offers **show more lines** right there — the
  reading continues inside the screen, and the notice goes away when it is done.
- **Mark as read** is for you: the `3 of 8 read` counter at the top helps you not
  lose a document in a big change. The mark belongs to **that change**: if the
  document changes again (or you save the version and edit it once more), the card
  comes back as unread — it is another text to read.
- A file that is not text (an image, an audio file) says **the lines of this file
  cannot be shown** instead of drawing an empty diff.
- If the project keeps no versions yet, the screen says so and what to do. If
  nothing changed, it says **everything saved** and which draft holds the last
  version — and the next step it offers is always one that works: with the team
  connected, **send it for review**; with GitHub not connected, **connect GitHub in
  Settings** (with the door right there); offline, it says the sending comes back
  **when the network does**.
- **A version keeps what is already in the file.** If an open document has text you
  have not saved yet (the tab shows ●), the screen says **unsaved text in
  ‹document›** and offers **open the document** — save it there, and the change
  shows up here. With an empty list that is the screen's answer, instead of
  “everything saved”.

### Saving the version from here

- The **Describe the change in one line** field sits next to the changes it
  describes, so the button **commits directly** — no sheet in between. The
  sentence above it states the price before the click: it keeps the **whole
  project**, every topic, not only the open document.
- **⎇ in the draft ‹name›** says where you are; **switch draft** opens the list.
  It calls the places what the screen calls them: **official knowledge** and
  **draft “name”** — and the switch sheet says **where** you are going and **how**
  to come back, with the price (how many documents leave the screen, and that
  nothing is deleted). Creating a new draft is a single field, with the `0/24`
  counter and the name preview live as you type.
- After the switch, the toast calls the place **by the same name** (“⎇ draft
  “invite-deadline””, “⎇ official knowledge”) and repeats the price that was paid
  (“7 documents stayed in the previous draft”). Git's internal name appears nowhere —
  and the chip, the empty state and the toast change **together**.
- While there is a change that is **not in any version yet**, switching drafts is
  not possible — Loro would keep half a change behind. The rows are dimmed and say
  **save a version first**, and **＋ new draft…** still works: a new draft **takes
  the change with you**.
- If you are **on the official knowledge** (or on a branch that is not a Loro
  draft), saving **creates a working draft** — nothing is written straight into the
  official knowledge. The screen says so before the click and shows the name your
  description will give it (`saving creates the draft “invite-deadline”…`), by the
  same 24-letter rule as the **New draft** sheet.
- With no description the app asks for one and commits nothing. With nothing
  changed the button is switched off (the empty state right above explains why).
- If the **team is not connected yet** (or the network is down), the screen says so
  **before the click**, right above the buttons, and **↗ Send for team review** is
  switched off: saving a version keeps working (it is local), and **open Settings**
  goes straight to the **Versions and GitHub** section, where everything that is
  missing is named with its remedy.
- **↗ Send for team review** opens the sending sheet. The fields are the
  **sections of the team's template** — the file the repository already carries,
  not a list Loro invented. **Configure the template** lets you change the
  sections (one per line): the change applies to the whole team and goes through
  the **same review** as any other.
- If sending **fails** (GitHub down, the team not connected), the sheet **does not
  close**: the reason appears inside it, what you typed is still there and the
  button is still armed. When what is missing is a setting, the sheet itself offers
  **open Settings** — fix it, come back, click again.

### Team reviews

- Two lists: **Waiting for your review** and **Your changes · and the ones you
  reviewed**. Each row carries the number, the subject, the state (**changes
  requested**, **approved**), whose it is, which draft it comes from and when it
  moved. **The title opens the review** — by mouse or by keyboard, and anyone using
  a screen reader hears the state along with the subject. **⧉ Copy link**, beside
  it, takes the address to paste in the team's chat.
- **A version lands on the draft you are on.** Saving a version does not move you:
  it is recorded in the working draft you are already standing on. Only when you are
  on the **official knowledge** does saving create a draft — and its name is stated
  before the click, because the official branch takes no direct change.
- **Switching drafts takes your unsaved change with you.** If the document differs in
  the target draft the switch is refused and the screen says which document — saving a
  version first is what resolves it.
- **The draft lives in the header.** The `⎇` chip beside Record says which working
  draft you are on — that is where your next version lands — and opens the sheet to
  switch or create one. In a narrow window it keeps only the glyph, and the name stays
  in its title and in the sheet it opens.
- **Saving the document writes the file, and nothing else.** In edit mode, **Save**
  writes the text to disk. A project version is a separate act with its own door:
  Review (or the ✦ IA panel's TEAM section) — a commit keeps the whole project, not
  the document in focus.
- **The screen stays live.** With Review open, the app re-reads your changes and the
  team's reviews on the same 10-second clock as the rest of the screen — there is no
  "refresh" button because none is needed, and the list never sits there saying
  "everything saved" while the sidebar shows the unsaved-change dot.
- **Sending is a step only the first time.** While the draft has no open review,
  **↗ Send for team review** is the decision to share, and nothing leaves your
  computer before it. Once the review exists that button **leaves the screen** —
  there is no step left to offer: **Save a project version** already records the
  version and takes it to the open review, and the screen says which one (#N), with
  the door to it. With no network the version stays saved here and the review gets
  the update when the network comes back — the screen says that too, instead of
  claiming it updated.
- **The list opens at once.** Reading the team costs a network round trip, so Review
  shows the list it already knows immediately and fetches the current one behind it.
  While what is on screen is the previous reading, the screen says so — and with no
  network it says that one is the last reading taken, and that it refreshes on its own
  when the network comes back.
- **The reading happens here.** Opening a review shows the description in the
  template's sections — **read as markdown**, the same way a project document is:
  headings, lists, tables, emphasis and code blocks come out formatted, not as the
  characters the author typed. The same holds for every comment in the
  conversation. **What changes** (the documents, each with the same card and
  the same diff as "what you changed") and **Conversation** (each commented line,
  with the quoted excerpt, who wrote it and when; **reply** sends the answer from
  inside the app). Each **reply** says which conversation it belongs to
  (`reply — contexts/…:13`), and the reply sheet repeats the address, who wrote
  there and the excerpt — a reply cannot land in the wrong conversation.
- **Your review** offers **✓ Approve**, **request changes** or **comment only** —
  and says what your approval is worth. Requesting changes or commenting with
  nothing written is refused, with the reason.
- **A review can come back to you.** If the author saves a new version after your
  approval (the chip says **approval of an earlier version**), or if your review is
  requested again, the decision is **offered once more** — and the screen says why:
  “your approval was for an earlier version…”, “%1 asked for your review again.”. A
  decision that still stands remains just the **state**, with no button again.
- After **requesting changes**, the reader is you: the screen says **you requested
  changes** and that the change does not enter the official knowledge while the
  request is open — the next step is the author's, and you are told here when your
  review is asked for again. For the **author** of the change, the same screen says
  who asked and what they have to do (answer, save a new version in the draft, ask
  for a new review).
- When the change is **yours** and the approvals and checks are in order,
  **Merge into the official knowledge** appears — and the copy says, before the
  click, what merging does and which draft it closes. The two never appear at
  once: whoever can approve cannot merge, and a review already decided shows its
  **state** instead of offering the button again.
- When there is a **conflict** with the official knowledge, or a failing check,
  the merge button is **not offered**: the screen says what happened and where to
  resolve it. Nothing is lost.
- **Failing checks** lists each one **by name** (the name your team gave it in
  CI), with **see the check ↗** to open its run. Being told that "the checks"
  failed without being told which one forced you to leave the app.
- **⎇ Open to edit** switches to the other person's draft, through the same price
  notice as any switch. Under **what you changed** an amber banner then says whose
  draft it is and which review it updates, with **back to my draft**.
- **Open on GitHub ↗** is still there for what the app does not do: applying a
  code suggestion and marking a conversation resolved happen there.
- With GitHub not connected, this half says what is missing and takes you to
  **Settings**. Offline, it says the list is the **last reading taken** and that it
  comes back on its own when the network does — and **saving versions keeps
  working**.

**How to get there:** the **Review** destination in the header, ⌘K (**Review** and
**See the team's reviews**), the **TEAM** section of the ✦ AI panel, and the notice
at the top of **Knowledge**. None of those doors expires.

## Save version and send for team review

- **⎇** shows the current **working draft**; click it to switch drafts or create
  a new one. A knowledge change is **always born in a working draft** — the
  official knowledge stays protected.
- **Save a project version** stores the **whole project** — every topic, not only
  the open document — in the history, inside the working draft you are on, with
  the sentence you write. That sentence describes the version; it **does not
  switch drafts** (that is what **⎇** is for). Offline? The flow stays local and
  the app tells you.
- When there is nothing new to keep, the button reads **all saved ✓** and is
  switched off: there is no empty version. Ask for one anyway (from ⌘K, say) and
  the app answers **nothing changed since the last version** — and no draft is
  created.
- **↗ Send for team review** publishes the working draft and opens the review.
  The topic owners review it; when they approve, the change becomes the official
  knowledge. After sending, the notice offers **open the review** and **see
  reviews**, which lands on the **Review** destination — where the reading
  happens, without leaving Loro.
- **See the team's reviews** is always within reach: the **Review** destination in
  the header, the **TEAM** section of the ✦ AI panel, ⌘K, and the notice at the
  top of **Knowledge**. You never depend on catching a notice as it goes by, and
  a destination cannot be dismissed.
- Without GitHub configured, saving versions still works **locally** and the
  **TEAM** section points at where to connect it (**Settings → Versions and
  GitHub**). On the **remote repository** row of **Settings → Versions and
  GitHub**, the **connect** button creates the team repository and connects the
  project — the app states first what goes up (only what is already in versions;
  meetings, notes and items to organize stay on this computer).
- **Offline is not the same as unconfigured**: with everything connected and the
  internet down, the badge reads **offline**, the TEAM section explains that the
  review comes back when the connection does, and the link is **check again**.
- Every version is signed with the **git identity** (name and e-mail) — that is
  what the team sees in the history. In **Settings → Versions and GitHub**, the
  **git identity** row has a **fix** button; the e-mail has to be a real address
  (`ana@exemplo.com`), otherwise the signature reaches nobody.
- Switching drafts with changes not saved into a version yet is blocked — save
  the version first.
- This section is the **per-document** route, in the ✦ AI panel: the changes are
  not on screen here, so saving goes through a sheet that states the price. Under
  **Review → what you changed** the changes are right there and the button commits
  directly, with the same price written above it.
- In **⎇**, every row says **how much that draft keeps** ("18 documents", or
  "nothing kept here yet"). Switching to a draft that does not have your
  documents **takes those documents off the screen** — nothing is deleted, they
  stay kept on the draft you were on and come back when you go back to it. The
  app tells you how many leave and where you come back from **before** switching.

## Ask the project

- **ask the project** is a skill like any other: it is on the **✦ AI** panel's
  chips, in the **all ▸** list and on the palette (`Cmd/Ctrl+Alt+Q`). The answer
  anchors on the project's knowledge and says clearly when the base does not
  cover the subject.
- Next to **↗ Send for team review** there is an **ⓘ** explaining the flow: it
  publishes the working draft and opens the review for the topic owners.

## When a new version is out

Loro checks once a day whether a new version has been published and says so in
three places: the version tag at the top stands out (**v0.13.1 available**), the
**⚙ Settings** row in the sidebar gets a dot, and **Settings → Updates** tells
the whole story.

There you see the installed version, the latest published one, and **how to
update by the route you installed with**:

- installed with **Homebrew**: the app shows the `brew upgrade --cask loro`
  command with a copy button. Run it in your terminal, with Loro closed.
- installed from the **.dmg**: the app takes you to the release page, where you
  download the new `.dmg` and drag Loro into Applications over the old one.

Loro **does not download and does not install** the update for you — it shows
the way, and you decide when.

**What about privacy?** The query is anonymous: one request to GitHub's public
releases page, at most once a day, carrying nothing about you, your project or
what you record — not even the version you have installed. If you prefer, the
switch in **Settings → Updates** turns the automatic check off for good; the
**check now** button stays there for whenever you want to ask.

## FAQ

**Where is my data?** In the project folder you chose, and only there. Config
and models live in `~/.loro/`. No content leaves the machine without your
action (running an AI skill, sending a change for team review).

**What goes to the cloud?** Nothing, by default. "Send for team review"
publishes the working draft to your remote repository; AI skills read the local
knowledge first and state when they consult anything external.

**Can I have several projects?** Yes — the selector at the top of the
sidebar switches between projects and creates new ones.

**Why is "Turn into knowledge" disabled?** There is nothing to organize. Send
files from an idea (or drop files into the list) first.

**One of my topics showed up under "Knowledge nobody cites". Is it broken?**
No — the document is intact. The list only says no **other** topic points at it,
so anyone reading along the links never gets there. The fix is not in that topic:
open the neighbouring topic that hands work over to it and write the link there.
A new project starts with every topic on that list, and it empties as topics
begin citing each other.

**Claude does not open in the terminal.** Check that the CLI is installed
(`claude` on PATH) and that a project is configured. The app tells you when it
cannot open it.

**"Could not find the AI agent command on this computer."** Loro looks for the
agent where it is usually installed (Homebrew, `~/.local/bin`, `~/.claude/local`)
and on your terminal's own PATH — you do not have to edit any PATH. Two things
produce this message: the agent really is not installed, or you installed it
**after** opening Loro (restart the app; it is a one-time thing). If your agent
lives somewhere unusual, write its full path in the agent field under ⚙ → project
settings (`/opt/homebrew/bin/claude`, for instance).

**How do I resize the sidebar?** Drag the divider between the sidebar and the
editor; with a wide sidebar, files show their date and git state. Double-click
the divider to reset.

**A tab showed another file's content.** The path at the top of the document is
the one that counts: **save version** stores the active tab, not what is drawn.
If the two disagree, close the tab and open the document again — and open an
issue with the steps.

**Which language is content generated in?** The language you chose when
creating the project (pt-BR or English) — the whole UI follows it. You can
switch later in the gear (⚙); a project may hold documents in both languages
if you switch. The on-disk folders (`meetings/`, `notes/`, `attachments/`,
`contexts/`) stay Portuguese regardless of language.

**What is a "custom skill"?** An AI skill you author yourself — either by
describing what it should do (the AI writes it) or by importing one you
already have. It becomes a real slash-command (`/skill-name`) and shows
up in the sidebar's "AI skills" section; run it via an idea's or
meeting's ⋯ menu ("run skill…").

**Can I delete a built-in skill (sync, presentation, artifact)?** No —
you can edit it, but not delete it. Only custom skills (the ones you
create) can be deleted.

**What does "auto mode" actually do?** It's the "Automatic" usage template
(chosen at creation, the default). With it, the agent can create a new topic
or decide which one to assign something to, on its own, while processing the
organizing. With any other template (or after turning it off in Settings), it
never creates anything new by itself — it leaves the item pending in the
**to organize** and reports that it needs your manual decision. It never affects
assigning to a topic that already exists.

**Why don't a meeting's notes show up right away?** They're
collapsed by default so the sidebar doesn't grow too large — tap the ▸ arrow
next to the meeting to open it. Analyses, answers and any document an AI skill
generated all live in the meeting's **notes/** folder.
