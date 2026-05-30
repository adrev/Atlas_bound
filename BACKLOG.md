# BACKLOG.md — Atlas Bound work tracker

Shared backlog for the two agents working this repo (see `AGENTS.md`).
**CodeX is PM and owns triage, priority, and what ships.** This file is the
durable record of known work so nothing gets lost between sessions; both
agents update it as items move. Most of the Tier 1–4 list below came from a
fan-out **repo audit** (multiple agents sweeping the codebase) — treat
findings as *leads to confirm*, not verified bugs, until someone checks the
specific file/line.

**Status legend**
- ✅ done & merged to `main`
- 🔵 in an open PR (not merged)
- ⚠️ **shipped in code but NEVER live-tested / deployed** — needs verification
- ⬜ not started
- 🔶 may overlap recent CodeX work — PM to dedupe before acting

---

## PM triage — current priority split

| Priority | Work | Owner | Next action |
|---|---|---|---|
| P0 | Clean dirty working trees before new feature work | CodeX/Claude | ✅ Done on main via PR #8 and PR #9. Continue to start new work from clean `origin/main`; local checkouts may run `git clean -fd dev public` only after confirming no real untracked work |
| P1 | PR #2 unverified Tier-1 fixes | Claude prepares sliced PRs; CodeX reviews/ships | Do not merge PR #2 wholesale while conflicted. T1.2 and T1.7 are done; next backend-testable slice is T1.6 after dedupe |
| P1 | OAuth + Chronicle migration verification | Claude | OAuth/Chronicle code landed in PR #8; verify Discord/Google login and Chronicle worker polling on the personal project |
| P1 | Browser websocket QA | Andrew/Claude desktop, coordinated by CodeX | Run the remaining browser-only rows: player ribbon refresh, reconnect/background tabs, kick/ban stale sockets |
| P2 | Server-side socket/combat QA tests | Claude | Add tests for combat/spell recipients, chat whisper/hidden-roll visibility, and music late-joiner state where feasible |
| P2 | Production infra hardening | Claude | Secret Manager migration, upload persistence, GCS CORS/old-bucket URL audit |
| P3 | Performance/code quality backlog | CodeX/Claude by claim | TokenLayer selectors, dice bundle deferral, list caching, large refactors after P1 stabilizes |

---

## ⚠️ READ FIRST — Tier-1 fixes that are written but UNVERIFIED

**PR #2 (`claude/clever-hopper-85609c`) carries ~7 UX/reliability fixes that passed `tsc` but were never deployed or manually tested.** They predate the two-agent workflow. PR #2 also has **merge conflicts with `main`** (AppShell hook-order fix in `6d1768f`; `deploy.sh`; possibly `customContent.ts` / `sessions.ts` which CodeX has since touched). Decision needed from PM: resolve + merge PR #2, or cherry-pick the still-relevant pieces.

Each item below needs a verification pass. "Unit-testable" = I can pin it headless; "browser" = needs Andrew's desktop.

| # | Fix | Where | Verify how |
|---|---|---|---|
| T1.1 | Scoped `ErrorBoundary` around BattleMap / TokenActionPanel / DiceTray | `client/.../ErrorBoundary.tsx`, AppShell, Sidebar, BottomBar | browser (force a panel throw) |
| T1.2 | ✅ Optimistic token-drag + **server-reject rollback** | `useDragToken.ts`, `server/.../tokenEvents.ts` | Merged in PR #10 with rollback tests plus hidden/invisible non-owner leak regression coverage; still worth a quick browser drag check |
| T1.3 | SessionLobby skeleton loaders | `SessionLobby.tsx` | browser |
| T1.4 | Modal a11y: focus-trap + ESC + ARIA (CharacterSheetFull, DiceTray, LootEditor) | `useFocusTrap.ts` + 3 modals | browser (keyboard nav) |
| T1.5 | On-blur form validation (ProfileModal, create/join session) | `ProfileModal.tsx`, `SessionLobby.tsx` | browser |
| T1.6 | `/state` ETag (304) + `/bans` pagination | `server/.../sessions.ts`, `stateSnapshot.ts` | 🔶 unit-testable — **CodeX has since changed `/state` & sessions.ts; check for divergence** |
| T1.7 | ✅ `customContent` validation 500→4xx + Zod `.errors`→`.issues` | `server/.../customContent.ts` | Merged in PR #11 with `handleDbError()` and SQLSTATE mapping tests |

> The user explicitly flagged: "we locked a ton of bugs, don't know if we tested all of them." T1.1–T1.7 are exactly that set. **These should be addressed (merged + verified) before being trusted in prod.**

---

## Tier 2 — performance / efficiency  (UX-perceived)

| # | Item | Status | Note |
|---|---|---|---|
| T2.1 | `TokenLayer` granular Zustand selectors (stop full re-render on any token change) | ⬜ | combat-jank source; client perf |
| T2.2 | Off-canvas culling for Konva grid/background layers | ⬜ | large maps |
| T2.3 | Defer Three.js dice-box bundle until first roll | ⬜ | initial-paint win |
| T2.4 | Reduce `/state` poll churn when nothing changed | 🔶 | heartbeat churn fixed in #3; PR #2 ETag idea still needs dedupe/re-measure |
| T2.5 | Collapse `assertCharacterOwnerOrDM` 4 sequential queries → one CTE | ⬜ | per-edit latency |
| T2.6 | Batch token-move broadcasts (one frame, N moves) | 🔶 | fan-out scoping/visibility centralized in #7; batching still open |
| T2.7 | `Cache-Control` on list endpoints (`/sessions/mine`, `/characters`, `/custom/*`) | ⬜ | quick win |

## Tier 3 — reliability / security

| # | Item | Status | Note |
|---|---|---|---|
| T3.1 | Lucia v3 deprecated → migration plan (Auth.js / Better-Auth / DIY) | ⬜ | no security patches incoming; not urgent |
| T3.2 | `npm audit fix` — 5 moderate vulns (uuid, express-rate-limit, postcss, brace-expansion) | ✅ | Done in PR #8; CI now runs `npm audit --audit-level=moderate` green |
| T3.3 | Zod-validate env at boot (fail fast on missing OAuth/DB secrets) | ⬜ | `server/src/config.ts` |
| T3.4 | Version/seq field for tokens + HP → detect concurrent writes | ⬜ | LWW currently silent |
| T3.5 | Await DB writes in `CombatService.applyDamage` (no fire-and-forget) | ⬜ | divergence risk on transient DB fail |
| T3.6 | Wrap character DDB import+merge in a transaction | 🔶 | CodeX touched DDB sync in `fe9a7d2` — verify if still needed |
| T3.7 | Tag `/state` snapshot with explicit `mapId` | 🔶 | CodeX added `mapId` to event log in `98bd0a6` — check if snapshot covered |
| T3.8 | Refactor opportunity-attack multi-tab fan-out logic | ⬜ | byzantine fallback path |

## Tier 4 — code quality / hygiene

| # | Item | Status | Note |
|---|---|---|---|
| T4.1 | Split `TokenActionPanel.tsx` (4877 lines) by domain | ⬜ | big mechanical refactor |
| T4.2 | Audit ~150 `as any` casts, add proper types | ⬜ | silent-failure risk |
| T4.3 | Pre-commit hooks (prettier + husky + lint-staged) + `.editorconfig` | ⬜ | also: lint npm script globs break on Windows bash (see below) |
| T4.4 | Vitest coverage thresholds on hot dirs (combat, dice, sockets) | ⬜ | |
| T4.5 | Enable `noUncheckedIndexedAccess` in `tsconfig.base.json` | ⬜ | |
| T4.6 | Decide Express v5 (pre-release) vs pin to v4 | ⬜ | |

---

## Operational / infra follow-ups

| # | Item | Status | Note |
|---|---|---|---|
| O.1 | Post-deploy verification: Discord OAuth, Google OAuth, char save round-trip, image upload round-trip, DGX Chronicle worker poll | ⬜ | needs new personal OAuth clients live + Andrew |
| O.2 | `UPLOAD_DIR` writes to local FS on Cloud Run — user uploads may not persist | 🔶 | CodeX hardened upload *auth* in `fe9a7d2`; persistence (GCS vs fuse) still open |
| O.3 | Move secrets to Google Secret Manager (`--set-secrets`) | ⬜ | currently plain env vars on the revision |
| O.4 | Apple OAuth not plumbed through `deploy.sh` | ⬜ | defined in `.env.example`, decide if wanted |
| O.5 | GCS bucket CORS for `dnd.kbrt.ai` on `atlas-bound-data-personal` (new bucket; I have Owner) + audit DB for old-bucket (`atlas-bound-data`) URLs | 🔶 | CodeX added a client fallback; CORS still cleaner |

## Websocket QA — remaining matrix rows

✅ Automated & merged: token-move hidden/map-scope/multi-tab fanout (#4).
✅ Automated & merged: ping / fog / zone scoping (#5).
✅ Automated & merged: token add/update visibility transitions (#7).

| Row | Status |
|---|---|
| `map:token-update` visibility promote/demote transitions | ✅ covered by #7 |
| Player ribbon activation + refresh returns to ribbon | 🔴 browser-only |
| Reconnect / membership (background-tab return, network reconnect, kick/ban no stale sockets) | 🔴 browser-only |
| Combat/spell recipient scoping (cast card, counterspell, shield, HP, conditions, death save, OA) | ⬜ partly server-testable |
| Music late-joiner sync; chat whisper/hidden-roll visibility | ⬜ partly server-testable |

## Housekeeping

- Current main checkout has uncommitted OAuth/Chronicle work: `DEV_SETUP.md`, `server/.env.example`, `server/src/auth/oauth/{apple,discord,google,origin}.ts`, `server/src/routes/{chronicle,internalChronicle}.ts`, `server/src/services/Chronicler.ts`. This appears intentional and contains no literal secret values in the inspected diff; Claude should either commit it to a named branch/PR or stash it before starting new work.
- CodeX temporary review/deploy worktrees were removed after PR #3/#4/#5/#7. Keep temporary worktrees short-lived and remove them after merge/deploy.

---

## How this file is maintained

- Both agents update it as items change status; **CodeX (PM) sets priority and sequences**.
- When a PR lands an item, mark it ✅ with the PR number.
- New findings get appended under the right tier with a status icon.
- 🔶 items must be deduped against recent commits before work starts — `git log` the relevant file first.
