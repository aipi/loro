# AGENTS.md — company context harness

This directory is the company's **portable brain**: a documentation pattern that
serves as context for **people** and **AI** alike, from engineering to sales. It
is the organization's **ubiquitous language**, versioned and navigable.

If you are an agent (Claude or other) running here, this file is your **harness**.
Follow it strictly.

## Golden rule
**DO NOT ASSUME PREMISES.** If something is not in the context, ask the person and
help them **produce** the missing context. You build understanding — you do not
guess. What is not confirmed becomes a **hotspot**, never an invented fact.

## How to answer a prompt (search order — ADR-0004)
1. **Route by domain.** Read `INDEX.md` (description · updated date · hotspot
   range per domain) and pick the relevant domain(s) — without opening files.
2. **Read the Summary card** at the top of `contexts/<domain>/context.md`
   (1 line per section + key IDs). Most queries stop here.
3. **Locate by stable ID** (`BR-…`, `D-…`, `H-…`) via search (grep) and read only
   the needed section. The whole file is the last resort, not the first.
4. **Only then** the raw inputs (`meetings/`, `notes/`) if more detail is needed.
5. Answer by guiding the **best decision** for the project/prompt — citing sources.

## What is what (one file per domain)
- `context.md` (per domain) — the **official source of truth**: a `description`
  (frontmatter, feeds the router) plus the consolidated knowledge. Anything not yet
  consolidated — open questions, contradictions, ambiguities, ideas under study —
  lives inline as a **hotspot**, in the format:

  > [!HOTSPOT] short title
  > What is open and why.

  Ideas are **not** separate files; hotspots are the domain's evolution backlog.
- `CHANGELOG.md` (per domain) — dated history, append-only.
- `.github/CODEOWNERS` — the owner(s) of each domain, who approve changes.

## Change = RFC = branch + Pull Request
A change proposal is **not** a document: it is an **RFC** materialized as a branch
and a Pull Request. The change is applied directly to `context.md` (+ `CHANGELOG`);
the PR **is** the RFC. The domain owners (`CODEOWNERS`) review and approve; merging
into `main` makes it the new source of truth. Versioning stays local by default;
remote collaboration (push + PR via `gh`) is opt-in and stores no credentials. The
agent does **not** open PRs — the person versions and proposes via Loro's
"Versionar" / "Propor mudança" actions.

## Producing context
When asked, help create/structure the knowledge that lands in `context.md`. A
**technical** decision (the *how*) becomes an **ADR** in the code repository,
not here.

## Processing raw material (inbox/)
Separate by the lenses **thoughts · emotions · desires · facts · actions**. Route by
domain. Facts/decisions → `context.md` (sections of consolidated truth) + `CHANGELOG`;
anything still open/contradictory → a **hotspot** in `context.md`. Meeting transcripts
→ `meetings/`; standalone notes → `notes/` (ephemeral sources, not the truth). If no
existing domain fits, **suggest creating a new one** — do not force the fit.

## AI model
If you are Claude, **prefer the Haiku model** for routine processing (summarizing
`inbox/`, transcripts) — faster and cheaper for that workload.

## New domain
Every new domain **must** have a `description` at the top of its `context.md`
(frontmatter) — it feeds the router. Without it, routing misfires.

## Org customization
`.claude/` here (skills, commands, hooks) may be tailored by the organization to
extend how the harness behaves. Keep it agent-agnostic where possible.
