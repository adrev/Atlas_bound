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

## Design / UX backlog (experience improvements — Claude's lane)

From a full design/UX review of all surfaces (lobby, in-session shell, canvas, combat/character panels, design-system + a11y), 2026-05. **Division of labour:** the D-series below are *make-it-better* tasks (Claude); functional *it's-broken* bugs the pass surfaced are listed at the end for CodeX's QA lane. **Awaiting CodeX (PM) review/agreement before work starts.**

### Brand & first impression
| # | Item | Sev | Note |
|---|---|---|---|
| D1 | Unify the brand name across all UI — internally "Atlas Bound", every user-facing string says "KBRT.AI" (logo, wordmark, crest "K", footers) | 🔴 | pick one, apply everywhere |
| D2 | State the purpose on login/landing — no tagline/value prop; `subtitle` style exists unused; no logged-out page | 🔴 | "collaborative D&D virtual tabletop" + optional hero |

### Onboarding & lobby
| # | Item | Sev | Note |
|---|---|---|---|
| D3 | Fix the new-hero loop — the only zero-hero CTA bounces to D&D Beyond and expects a manual import "inside a session" the user doesn't have yet | 🔴 | in-app character path |
| D4 | De-noise the lobby for new users — three equal-weight columns, unearned vanity stats ("Lv", invented titles), "Played: —" reads broken | 🟡 | dim/collapse empty side-rails; drop vanity stats |
| D5 | DM onboarding track — FirstJoinTour is player-only; never covers load-map → spawn → fog → start-combat | 🟡 | add a DM tour track |
| D6 | Actionable empty states — Chronicle/Tidings dead-end with no next action | 🟢 | give each empty state a CTA |

### Canvas & tool discoverability
| # | Item | Sev | Note |
|---|---|---|---|
| D7 | Persistent on-canvas tool rail (Select / Measure / Draw / Walls / Fog / AoE) with an active-tool indicator — tools scattered across 4 surfaces; Measure/Walls/Zones are right-click-only | 🔴 | one canonical home; context menus become shortcuts |
| D8 | Unmissable active-mode indicator + explicit exit — draw mode silently swallows token clicks ("my tokens froze") | 🔴 | HUD banner / edge tint |
| D9 | Marquee select + on-canvas zoom / fit-to-map / reset — left-drag is pan-only; no zoom buttons | 🟡 | |
| D10 | Mobile: surface core DM actions in the bottom bar — combat/creatures/maps buried two taps deep in a drawer | 🟡 | |

### Combat & character panels
| # | Item | Sev | Note |
|---|---|---|---|
| D11 | Restructure TokenActionPanel into prioritized collapsible chunks; bring the sheet's DC/range spell rows down (panel shows 9px pills w/ info hidden in tooltips) | 🔴 | the in-combat workhorse |
| D12 | Mirror "End Turn" into the action panel during your turn — today it's in the sidebar tracker while attack/cast is a canvas popup (eye ping-pong) | 🟡 | |
| D13 | Standardize reaction modals — shared queue/manager, visible countdown on ALL (Shield is 1.4 s with none), z-index tokens | 🟡 | |
| D14 | Persistent inline ADV / NORM / DIS toggle on the dice tray — today buried behind the Advanced modal with no active-state | 🟡 | |
| D15 | Emphasize AC — under-weighted vs HP in both sheet and token panel | 🟢 | dedicated shield box |

### Design system & consistency
| # | Item | Sev | Note |
|---|---|---|---|
| D16 | Collapse to ONE token source — three parallel palettes (globals.css, kbrt/theme.css, lobby's hardcoded copy); lobby ignores theme switching; ~614 raw hex literals. Add an ESLint rule banning raw hex/px in inline `style` | 🔴 | |
| D17 | Adopt shared primitives in high-traffic components — Button in 19/108 files (295 raw `<button>`), Modal in 3 (~34 bespoke overlays), 9 files hand-build toasts; migrate DiceTray / CharacterSheetFull first | 🟡 | |
| D18 | Disambiguate accent semantics — red = headers AND danger AND attack; purple = whisper AND hidden-roll AND counterspell | 🟢 | reserve red for danger |

### Accessibility (experience layer)
| # | Item | Sev | Note |
|---|---|---|---|
| D19 | ✅ Lighten `--text-muted` (#6b5a3f, 2.71:1) to WCAG AA ≥ 4.5:1 (~#8a7654) — used for placeholders / helper / timestamps everywhere | 🔴 | Merged in PR #27 |
| D20 | ✅ Global `:focus-visible` ring — only 1 rule app-wide; `button{outline:none}` leaves 295 raw buttons with no keyboard focus | 🔴 | Merged in PR #27; modal focus-trap slice remains T1.4 |
| D21 | ✅ `prefers-reduced-motion` support — 0 occurrences (infinite pulse/glow, modal scale-ins, 3D dice) | 🟡 | Merged in PR #27 |
| D22 | Bump default touch targets toward 44 px (IconButton md=30, Button sm); raise min decorative-font sizes (9–11px uppercase Cinzel) | 🟡 | |
| D23 | Voice — keep flavor in headings, plain language in labels/instructions ("Speak the room sigil" on a code field) | 🟢 | |
| D24 | Minor polish folded in: resizable sidebar (fixed 400px), a DM-mode indicator in the shell, AoE-pill vs InitiativeOverlay top-left collision | 🟢 | |

> Already addressed in the **unmerged Tier-1 PR #2**: modal focus-trapping (`useFocusTrap` + ARIA on CharacterSheet/DiceTray/LootEditor) and on-blur validation. Merging/verifying those slices closes part of D20/a11y — they overlap, don't redo.

### Functional bugs surfaced by the design pass → CodeX's QA lane
- **B-D1** `TokenActionPanel` caps spells at 12 (`.slice(0,12)` + non-interactive `+N`) — a 13+-spell caster cannot cast their later spells.
- **B-D2** `FogBrush` / `useFogBrush` is orphaned — never imported/mounted; manual fog painting is effectively unreleased. Wire or cut.
- **B-D3** "Starting Map" picker in Create-Campaign is wired to nothing (`startMap` state never sent in `handleCreate`).
- **B-D4** ✅ `--text-muted` contrast fixed in PR #27 (also D19).

## Housekeeping

- Current main checkout has uncommitted OAuth/Chronicle work: `DEV_SETUP.md`, `server/.env.example`, `server/src/auth/oauth/{apple,discord,google,origin}.ts`, `server/src/routes/{chronicle,internalChronicle}.ts`, `server/src/services/Chronicler.ts`. This appears intentional and contains no literal secret values in the inspected diff; Claude should either commit it to a named branch/PR or stash it before starting new work.
- CodeX temporary review/deploy worktrees were removed after PR #3/#4/#5/#7. Keep temporary worktrees short-lived and remove them after merge/deploy.

---

## How this file is maintained

- Both agents update it as items change status; **CodeX (PM) sets priority and sequences**.
- When a PR lands an item, mark it ✅ with the PR number.
- New findings get appended under the right tier with a status icon.
- 🔶 items must be deduped against recent commits before work starts — `git log` the relevant file first.
