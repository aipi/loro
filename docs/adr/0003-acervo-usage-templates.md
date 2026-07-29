# ADR-0003 — Acervo usage templates (presets) & per-acervo AI agent

- **Status:** accepted (owner decision, 2026-07-28)
- **Context:** opening Loro to non-technical audiences (the motivating case is
  a sales team living in spreadsheets, client contacts and calls) requires the
  wizard to offer a starting shape instead of a blank taxonomy — without
  breaking the baseline's "no built-in taxonomy" premise (ADR-0001 §4) and
  without coupling the product to one AI vendor.

## Decision

### §1 Usage templates (presets)

- A **usage template** seeds a new acervo: seed contexts, an `AGENTS.md`
  **vertical addendum**, the initial queue guide (`inbox/_prompt.md`) and,
  as a supported mechanism, extra skills copied into `.claude/commands/`.
  The addendum is *appended* to the generated `AGENTS.md`, never a
  replacement — the default body carries the loop mechanics the whole model
  depends on.
- **Builtins (v1):** `generico` (default — empty content, preserving the
  baseline behavior and the "no built-in taxonomy" premise as opt-in),
  `vendas`, `engenharia`, `produto`, `aprendizado`, `educacao`,
  `recrutamento`, `saude`. Further verticals (legal, etc.) are catalog
  evolution — the mechanism does not change.
- **On-disk format** (identical for builtins and custom): a directory with
  `template.json` (manifest: `version`, `name`/`description`/`contexts` as
  plain values or `{pt, en}` maps) plus optional `pt|en/AGENTS.md`,
  `pt|en/_prompt.md` and `pt|en/skills/*.md`. Missing language variants fall
  back to the other language.
- **Builtins are embedded** from `desktop/src-tauri/templates/<slug>/` via
  `include_str!` (module `presets.rs`): the binary stays self-contained and
  "duplicate to customize" is just writing the same bytes to disk.
- **Custom templates** live in `~/.loro/templates/<slug>/` (respects
  `LORO_HOME`). A custom template with a builtin's id **shadows** it (that is
  how a user edits "vendas"). `brain_duplicate_template` copies any template
  there with a `-2`/`-3` suffixed slug.
- The wizard prefills the contexts field from the template but the user's
  edited list is the truth — the backend never merges. The queue guide is
  seeded **only at first setup** (no `.brain/state.json` yet): the loop
  consumes `inbox/_prompt.md`, so re-materializations must never re-inject it.
- `Acervo.template` stores the preset id (serde default `"generico"`, so
  existing configs migrate implicitly). Seeding language follows the UI
  language at creation time (ADR-0002 §1).

### §2 Security posture

- Template ids pass a slug gate (`[a-z0-9-]{1,64}`) before any disk access —
  no path traversal into `~/.loro/templates`.
- Template content is **user data, never executed by the app** — the user's
  own AI agent interprets it, the same posture as `inbox/_prompt.md`. Logs
  carry the template id only, never content (BR-8). Manifests hold no
  credentials (BR-9).
- Sensitive-data verticals ship their guardrails inside the template itself:
  `saude` opens with an explicit warning (health data is sensitive personal
  data; the acervo is not a medical record), `recrutamento`/`educacao`/`vendas`
  instruct minimization (role over contact; operational data stays in the
  source system).

### §3 Per-acervo AI agent (agent-agnostic terminal)

- New `Acervo.agent`: the shell command launched in the embedded terminal
  (default `"claude"`). Any CLI the user owns qualifies — `gemini`, `codex`,
  `ollama run llama3`, a local model wrapper. Blank normalizes to the default.
  No curated vendor adapter layer in v1 (owner decision).
- The readiness handshake (`term_status`, ADR-0002 §4) detects the **basename
  of the agent command's first token** instead of the literal `claude`;
  `term_agent` exposes the active command to the frontend, which injects it to
  (re)launch the agent in the PTY.
- Slash-commands are a Claude convention. For any other agent the same skill
  is injected as a **plain one-line prompt** pointing at the instruction file
  the acervo already materializes ("Read and follow the instructions in
  `.claude/commands/<skill>.md` …") — `AGENTS.md` remains the neutral entry
  point, so the knowledge base stays fully agent-agnostic files + convention.
- BR-1 posture unchanged: whichever agent, it remains a disclosed third-party
  ambient sink (ai.rs `AMBIENT_SINK_DISCLOSURE`); nothing runs until the user
  invokes it.

## Consequences

- The wizard gains a template picker (localized from the manifests, not from
  i18n.js) and an agent command field; toasts on agent paths use neutral
  wording ("agente do terminal").
- Vertical skill *content* (e.g. `/brain-mensagem` generating sales follow-ups
  from an account's context) is deliberately out of v1 — the `skills/`
  mechanism ships tested, the catalog comes as its own RFC.
- Descriptive copy elsewhere in the app still says "Claude" where the flow is
  genuinely Claude-specific; a full wording sweep is deferred to the next
  docs pass.
