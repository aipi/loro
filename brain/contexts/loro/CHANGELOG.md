# loro — CHANGELOG
> Dated history; the loop only appends. Approved decisions rise to context.md.

## 2026-07-29 — efficient-reading layer for the acervo (ADR-0004)
Reading the knowledge base becomes cheap by structure, not by tooling: every
`context.md` now opens with a **Summary card** (1 line per section + key IDs,
regenerated on every update), decisions get stable IDs (`D-YYYY-MM-DD-<slug>`),
hotspots get `H-<n>`, and the `INDEX.md` line carries description + updated
date + hotspot range so routing decides without opening files. The generated
`AGENTS.md` and all skills teach the protocol explicitly: index → card → ID
search → targeted section read. Retrieval infrastructure (vector RAG, knowledge
graphs) was evaluated and deferred — see ADR-0004 §5. This brain adopts the
same layer (dogfooding). _Source: docs/adr/0004-acervo-reading-layer.md._

## 2026-07-28 — open-source preparation: one ADR, brain made consistent
Preparing the repository to go public: the thirteen ADRs (`0001`–`0013`) were
consolidated into a single `docs/adr/0001-baseline.md` (with a map from the
former numbers still referenced by code comments), following the precedent of
the v1 baseline that had consolidated the 38 pre-baseline ADRs. Every reference
to the internal acervo that motivated the recursive-subdomain work was
generalized. The **PRD concept was retired** to match what the code actually
does (the app generates only `context.md` + CHANGELOG per domain; proposals are
RFC=PR, never documents): the immutable business rules the code enforces (BR-1,
BR-8, BR-9) now live in a "Business rules" section of `context.md`, the
`changes/` folder is gone (its `prd.md` had in fact already been deleted by
accident in `bbed27a`), and every PRD mention in CLAUDE.md / CONTRIBUTING /
AGENTS.md / the ADR was replaced by the brain source of truth. The root README
was rewritten to describe the product as it is (capture + Knowledge Studio,
Brainstorming → Fila → Contexto).

## 2026-07-26 — brain reconciled to the ADR-0004 model
The repository's own brain was simplified to match the new acervo model: the
AGENTS.md harness now describes a single `context.md` per domain with inline
**hotspots** (ideas are no longer files) and change-as-RFC (branch + PR), with
approval by `CODEOWNERS`. Removed the ADR-0002 leftovers `OVERVIEW.md`,
`GLOSSARY.md`, the per-domain `glossary.md`, and the empty `ideas/` and
`references/` folders; kept `changes/0000-baseline/` as the founding PRD record.
The English folder names (`contexts/`, `meetings/`, `notes/`) were kept on purpose
(docs-in-English convention); the en/pt unification of the acervo contract is now a
hotspot for a future RFC.

## 2026-07-26 — knowledge becomes a versioned, collaborative flow (ADR-0004)
The acervo model changes: each domain's source of truth is now a single
`context.md` (this file was renamed from `_domain.md`), unconsolidated knowledge
lives inline as **hotspots** instead of separate idea files, and a change
proposal is an **RFC = branch + Pull Request** rather than a document. Git is
hidden behind two actions — *Versionar* (local branch + commit) and *Propor
mudança* (push + PR via `gh`) — with remote collaboration opt-in, approval by
`CODEOWNERS`, and no credentials ever stored. This entry dogfoods the new flow:
the redesign itself is recorded here, and its open points live as hotspots in
`context.md`. _Source: docs/adr/0004-knowledge-versioning-and-collaboration.md._

## 2026-07-24 — v1 baseline
Loro reaches v1: local capture + portable context harness by domain. The 38
exploratory engineering ADRs were consolidated into `docs/adr/0001`; product
context moved here (domain `loro`). _Source: changes/0000-baseline/prd.md._
