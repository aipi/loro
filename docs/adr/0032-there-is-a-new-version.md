# ADR-0032 — «Há uma versão nova»: the app tells you, by the route you installed it

- **Status:** **accepted and implemented** (owner decision, 2026-08-20)
- **Date:** 2026-08-20
- **Extends:** ADR-0006 (Homebrew cask as the recommended install; models downloaded on
  demand with system `curl`), ADR-0015 (release by PR — the GitHub Release is the
  publication event), ADR-0012/0023 (Windows is a mapped destination, not a promise),
  ADR-0022 §28 (a synchronous Tauri command runs on the main thread — that is the freeze
  class), ADR-0001 §10 (the screen gets product error codes, never an errno)
- **Origin — owner request, 2026-08-20:**

  > quero construir uma forma de mostrar que o app precisa de atualização sempre que uma
  > nova release for gerada no github. Precisamos pensar em macos, por enquanto e deixar
  > aberto para os demais SO.

  and, when asked what should happen after the notice:

  > nao da para baixar com brew? […] Só mostrar o comando

---

## 1 · The problem, stated as a fact

Loro publishes a GitHub Release on every version (ADR-0015) and Homebrew users can
upgrade with one command. **The running app knows none of this.** `v0.13.0` was on the
owner's screen while `v0.13.1` had been published — the app had no way to say so, and
nothing in the product ever mentions that a newer version exists. An app that cannot say
"there is a newer me" leaves its user on a version with known bugs, indefinitely.

## 2 · Decision

**The app checks, tells, and shows the command. It does not download and it does not
install.**

1. Once a day at most, at startup, Loro asks GitHub's public releases API what the
   latest published version is, and compares it — **by number, not by text** — to the
   version it was compiled as.
2. If a newer one exists, three surfaces derived from that one fact say so: the version
   tag in the header, a dot on ⚙ Configurações, and the new **Configurações →
   Atualizações** section.
3. That section shows **how to update by the route this user installed by** — the
   Homebrew command for a cask install, the `.dmg` page otherwise — plus «verificar
   agora», «ver notas da versão», and the switch that turns the whole thing off.

### 2.1 · Why the app does not run the update itself

Two facts, not a preference:

- **The bundle is not signed with a Developer ID** (release.yml states this, and the
  release notes carry the `xattr -d com.apple.quarantine` instruction). A real
  auto-updater would have to answer Gatekeeper and quarantine first. That is its own
  project, not this one.
- **`brew upgrade --cask loro` replaces the `/Applications/Loro.app` that is running.**
  Running it inside Loro's own embedded terminal makes brew a *child* of the process
  whose bundle it is replacing. The owner chose the option with no such hazard: show the
  command, let the user run it where they choose.

## 3 · Invariants

1. **The app never claims a measurement it did not take.** There are three states, not
   two: «há uma versão nova», «você está na última versão» and «ainda não verificado».
   A skipped check (interval not elapsed, switch off, no network) never renders as "you
   are up to date" (CLAUDE.md §7.1).
2. **Comparison is numeric.** `0.9.0` vs `0.10.0` sorts backwards as text, and that is
   precisely the release where the notice would have to work.
3. **The instruction matches the installation.** `brew upgrade --cask loro` is offered
   only when a Homebrew Caskroom entry for loro exists on disk. Offering it to a
   `.dmg` user sends them to collect `Cask 'loro' is not installed` in their terminal.
4. **A check the user did not ask for never becomes an error on screen.** Only
   «verificar agora» reports failure, because only there is somebody waiting for an
   answer.
5. **The network is never on the critical path of startup.** `--max-time 8`, off the
   main thread, 1.5s after boot. If GitHub is unreachable the app is unchanged.
6. **Nothing about the user leaves the machine** (BR-8). The request is an anonymous
   `GET` to a public endpoint with a fixed `User-Agent` — not even the installed version
   is disclosed. On disk, `~/.loro/update.json` holds a timestamp, the last version seen
   and the on/off switch. No transcript, no project, no identifier.
7. **BR-1 is untouched.** Inference stays local; this is a version string, not a model.

## 4 · Mechanism

| Concern | Where |
|---|---|
| Policy (interval, switch, version comparison, route, payload parsing) | `desktop/src-tauri/src/update.rs` |
| Wiring (compiled version, disk, network off the main thread) | `lib.rs` — `update_check`, `update_set_enabled`, `update_open_release` |
| What the screen says | `desktop/src/update.js` (pure, testable) + `paintUpdate()` in `app.js` |
| State | `~/.loro/update.json` — `{ enabled, lastCheck, latest }` |

**No new crate.** The query uses system `curl` over HTTPS only (`--proto =https`), the
same decision `models.rs` already took for model downloads (ADR-0006).

**Asynchronous on purpose.** The body reaches the network, so it runs in
`spawn_blocking` like `env_doctor`. A synchronous Tauri command runs on the main thread —
that is the 18s freeze of ADR-0022 §28, and this is the third feature in the codebase
that would have reintroduced it.

### 4.1 · IPC contract

```
update_check(force: bool) -> UpdateStatus | err.update_check_failed
update_set_enabled(enabled: bool) -> UpdateStatus | err.update_pref_save
update_open_release() -> () | err.update_open_failed

UpdateStatus = { current, latest, available, checked, enabled, lastCheck, route, command, url }
route = "brew" | "download"
```

`checked` is the field that keeps invariant 1 honest: it distinguishes "I looked and
there is nothing" from "I did not look".

## 5 · Other operating systems

The **check** is identical everywhere — same endpoint, same comparison, same state file.
Only the **route** is per-OS, and it is one `enum` with one function
(`update_command`). Today macOS is the only system the project packages (ADR-0006), so
it is the only one with a named route; Windows and Linux fall to `Route::Download`,
which is the release page. Giving Windows a `winget upgrade` route later is a variant
and a string, not a redesign.

## 6 · Surfaces (DESIGN.md)

- **Header:** the `v0.x.y` tag becomes a button when — and only when — an update exists;
  it keeps the exact weight and colour of the tag otherwise, so the header gains no new
  control for a state that is almost never true. It is *decoration* under DESIGN §2
  rule 9 and disappears below 1015px, which is why it is not the only door.
- **⚙ Configurações (sidebar):** a 7px dot. This row survives every window width.
- **Configurações → Atualizações:** its own nav section. It is deliberately **not**
  inside «Versões e GitHub» — that section is about versioning the *knowledge* (salvar
  versão, rascunho, revisão), and the app's own version must not share vocabulary with
  it (DESIGN §4).

## 7 · Tests

Rust (`update.rs`) — 12 cases, including: numeric comparison across the `0.9 → 0.10`
boundary; a local build *ahead* of the release is never told to update; unreadable
versions announce nothing; drafts, prereleases and invented tags are refused even from
a mirror; one check per day and the button always gets through; the switch off means no
automatic call, ever; a skipped check keeps the old stamp and does not claim freshness;
the notice survives a restart without asking the network again; the query is HTTPS-only
and carries nothing about the user.

JS (`update.test.js`) — 6 cases: the header tag in both states, «não verificado» is not
«está atualizado», the Homebrew command only for Homebrew installs, no 1969 stamp, and
every string has an English pair.

**Two findings the tests produced, both fixed in the code, not in the test:**

1. `lastCheck: 0` (a fresh install) fell into the `now - lastCheck >= 24h` arithmetic, so
   whether the first check ever happened depended on the clock — with the test clock at
   10s it never did. «Never checked» is now its own branch.
2. A stamp **in the future** (a clock set forward, then corrected) saturated the
   subtraction at 0 and would have locked the notice off forever. Same branch, same
   answer: check.
