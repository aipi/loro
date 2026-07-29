---
domain: loro
description: >
  The Loro product itself — a local speech-capture app + portable context harness
  organized by domain. Route here anything about the tool: capture, the acervo/
  brain, the loop, UI, packaging, and Loro's own product & architecture decisions.
archetypes: [product, engineering, design]
updated: 2026-07-29
---

# loro — source of truth

> The editable base of this domain. It synthesizes what is **decided and
> approved**. A change proposal is an **RFC = branch + Pull Request** applied
> directly to this file — merging makes it the new truth. There are no proposal
> documents; open questions live below as hotspots.

## Summary

_Quick-read card (ADR-0004): 1 line per section + key IDs. Read this first;
open only the section you need._

- **What Loro is** — a companion that captures speech locally and builds a
  per-domain context base for people and AI; it also wraps an AI agent CLI
  in one-click automations (buttons/palette) instead of typed commands.
- **Core premises** — earned context, archetypes over areas, interpretation
  lenses, self-contained & non-destructive.
- **How it works** — capture → inbox → loop files by domain → person promotes.
- **Business rules** — BR-1 local inference · BR-8 content-free logs ·
  BR-9 no credentials.
- **Hotspots** — H-1 Knowledge Studio flow · H-2 usage templates & vertical
  skill catalog · H-3 en/pt folder divergence · H-4 CODEOWNERS enforcement ·
  H-5 end-user packaging · H-6 external-source sync & habilidades scope.

## What Loro is
A **companion** (not a replacement for agents) that captures speech 100% locally
and turns what is discussed into a per-domain context base — usable by people and
AI. It is a project-management philosophy on top of a personal/team brain, made
one's own via a customizable `AGENTS.md`.

Loro is also an **AI-agent wrapper/automation tool**: it embeds an AI agent CLI
(`claude` by default, any CLI — ADR-0003) in a terminal inside the app, and
turns that agent's skills — called **habilidades** — into one-click UI instead
of typed/remembered slash-commands. They run from a picker (friendly names,
always-visible descriptions) on the Visão Geral, a brainstorming/meeting `⋯`
menu, or the right-side actions rail of any open file. Nine ship built-in
(`/loro-context`, `/loro-ask`, `/loro-analyse`, `/loro-question`,
`/loro-note`, `/loro-sync`, `/loro-presentation`, `/loro-artifact`,
`/loro-tool`); the user can author custom ones (AI-drafted or imported) and
edit built-ins (never delete them). External material comes in through
`/loro-sync` (Drive doc, or a Slack/Jira/Confluence summary) as a **local
anexo** — the app never holds a credential (BR-9); the agent uses its own
connectors. The capture tool and the knowledge base are what the automations
act on; the automation layer is how the user reaches them (ADR-0005).

## Core premises
- **Ideas are cheap; context is earned.** Brainstorming is constant and free;
  context (production knowledge) is promoted only after debate and approval.
- **Organize by archetypes, not areas** (product/business/engineering converge on
  a shippable outcome); built for groups and forming teams.
- **Four+ lenses** to interpret material: thoughts, emotions, desires, facts,
  actions — guidance for *where* things go, not the output structure.
- **Self-contained & non-destructive**: detect existing structure, respect it,
  fill only gaps. DDD context-mapping / event-storming are light references.

## How it works (approved)
Capture → `inbox/` → the loop interprets and files by domain → the person promotes
proposals to source of truth. Technical *how* lives in the code repo as one
consolidated ADR (`docs/adr/0001-baseline.md`), generated from approved changes here.

## Business rules (immutable)
Tests must cover each rule explicitly, naming it (CLAUDE.md §3). The numbering
is inherited from the founding requirements; only the rules the code references
kept their numbers — the gaps were consolidated into these or retired.

- **BR-1 — inference stays local.** Audio and transcripts never leave the
  machine by default; raw audio never leaves it under any circumstance. External
  calls exist only as an explicit, per-invocation, user-driven opt-in
  (ADR-0001 §3/§9).
- **BR-8 — logs are content-free.** Structured logs never contain transcript
  content, PII or secrets; markers/stats are structural (type/timecode/ref).
- **BR-9 — no credentials.** No token/secret is ever requested, stored or
  logged; external tools use the user's own ambient credentials.

Unnumbered founding rules, kept: ephemeral sources (fila, meetings, prompt
history) are unversioned; only approved content is source of truth.

## Hotspots
Evolution points not yet consolidated — the origin of the next RFCs. (Dogfooding
the model: ideas live here, inline, not as separate files.)

> [!HOTSPOT] H-1 — Knowledge Studio: the Brainstorming → Fila → Contexto flow
> The product is a VS Code-like studio (multi-tab, command palette, CodeMirror 6,
> ADR-0001 §6) organized around ONE sequential, visible flow (ADR-0001 §7):
> **Brainstorming → Fila → Contexto**. A *brainstorming* (`brainstorming/<slug>/`,
> the renamed NON-VERSIONED world — was `pessoal/temas/`, one .gitignore line)
> gathers meetings/investigations/questions/notes; the user elects parts into ONE
> consolidated report that enters the *fila* (the `inbox/` queue); "gerar contexto"
> runs `/loro-context` (the renamed loop skill) to distill the fila into VERSIONED
> `contextos/` (RFC=PR, ADR-0001 §5). Meetings are living folders with a built report;
> audio is transient (deleted after transcription). Meeting AI (`/loro-analyse`,
> `/loro-question`) runs as a terminal-Claude skill, LOCAL-FIRST (reads the context
> before any external/MCP source). Direct promotion (`brain_promote`) is retired
> from the primary path. Recorded in ADR-0001 §6–§9. Open: fate of legacy notas/.

> [!HOTSPOT] H-2 — Usage templates (presets) & per-acervo agent — vertical skill catalog pending
> The wizard now offers usage templates (generico, vendas, engenharia, produto,
> aprendizado, educacao, recrutamento, saude) and a per-acervo AI agent command
> (any CLI, `claude` default) — ADR-0003. Shipped: structure seeding (contexts,
> AGENTS.md addendum, queue guide), custom templates in `~/.loro/templates`,
> agent-agnostic skill injection. Open: further built-in verticals (legal, …)
> and a full "Claude"→"agent" wording sweep in descriptive UI copy. The
> vertical skill *catalog* item is superseded by ADR-0005's custom tools
> (`/loro-tool`): rather than Loro shipping every vertical skill, the user
> authors their own (AI-drafted or imported) and it appears in the
> "🧰 habilidades" list, run via "⋯ → executar habilidade" from a
> brainstorming or meeting (ADR-0005 moved it off the Visão Geral to keep
> the home screen from accumulating cards).

> [!HOTSPOT] H-6 — External-source sync & habilidades: scope of what gets attached
> ADR-0005 shipped `/loro-sync` (Drive/Slack/Jira/Confluence) and
> user-authored habilidades (`/loro-tool`, plus built-in `/loro-presentation`/
> `/loro-artifact`) as a "🧰 habilidades" surface (sidebar + "executar
> habilidade" picker). Sync now brings CONTENT into a local anexo
> (`brainstorming/<tema>/anexos/`) — Drive the full doc, Slack/Jira/Confluence
> an agent-written summary — referenced by a `tipo: doc` ref, superseding
> ADR-0005 §4's link-only posture; BR-8 holds because the content lives in
> the acervo's own material, never a log. Built-in habilidades are editable
> but never deletable. `autoContext` also gained a real effect: on
> (default), the loop may create a context the fila needs; off, it leaves
> the item pending instead of guessing (`.loro/settings.json`, distinct from
> the global config). Contexts can now also hold `anexos/` (opt-in
> versioning checkbox at "gerar contexto"). Open: whether habilidades should
> be shareable/exportable between acervos or teammates, and whether more
> sources (email, calendar) follow the same content-into-anexo pattern.

> [!HOTSPOT] H-3 — Acervo folder language diverges between brain and app (en vs pt)
> This brain uses English folders (`contexts/`, `meetings/`, `notes/`) as the
> company harness (docs-in-English convention). The app materializes an acervo in
> Portuguese (`contextos/`, `reunioes/`, `notas/`, `anexos/`) and its reader walks
> `contextos/`, so the app cannot open this brain directly today. ADR-0005 §6
> added a per-acervo **language choice** at creation (pt-BR / English) that
> drives the UI and generated *content* — but the on-disk **folder names stay
> Portuguese** regardless (the reader depends on them). Open: the en/pt
> unification of the folder contract itself is still deferred to its own RFC.

> [!HOTSPOT] H-4 — CODEOWNERS enforcement when the brain is not its own repo
> Approval (ADR-0001 §5) relies on GitHub CODEOWNERS + branch protection. The
> dogfooding brain lives inside the app repo, so a `brain/CODEOWNERS` is only
> illustrative — GitHub reads CODEOWNERS at the repo root/`.github`/`docs`.
> Open: extract the brain to its own repo, or map ownership at the app-repo root?

> [!HOTSPOT] H-5 — End-user packaging & cross-OS setup (carried over)
> Whisper packaging for end users; Windows/Linux system-audio setup; the
> experimentation mode for still-undefined domains.
