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
| P1 | PR #2 unverified Tier-1 fixes | Claude prepares sliced PRs; CodeX reviews/ships | **Never merge PR #2 wholesale — slices only.** T1.2 ✅ #10, T1.7 ✅ #11, T1.6 ✅ #14; remaining T1.1/T1.3/T1.4/T1.5 are browser-verify |
| P1 | OAuth + Chronicle migration verification | Claude | OAuth/Chronicle code landed in PR #8; verify Discord/Google login and Chronicle worker polling on the personal project |
| P1 | Browser websocket QA | Andrew/Claude desktop, coordinated by CodeX | Run the remaining browser-only rows: player ribbon refresh, reconnect/background tabs, kick/ban stale sockets |
| P2 | Server-side socket/combat QA tests | Claude | Add tests for combat/spell recipients, chat whisper/hidden-roll visibility, and music late-joiner state where feasible |
| P2 | Production infra hardening | Claude | Secret Manager migration and GCS old-bucket URL audit; upload persistence is live in #117 |
| P3 | Performance/code quality backlog | CodeX/Claude by claim | TokenLayer selectors, dice bundle deferral, list caching, large refactors after P1 stabilizes |

---

## ⚠️ READ FIRST — Tier-1 fixes that are written but UNVERIFIED

**PR #2 (`claude/clever-hopper-85609c`) carries ~7 UX/reliability fixes that passed `tsc` but were never deployed or manually tested.** They predate the two-agent workflow and PR #2 conflicts with `main`. **PR #2 is never merged wholesale** — it stays as source material only until closed as superseded. Each still-relevant slice is extracted/rebuilt as a focused PR off clean `origin/main` (done: T1.2 #10, T1.7 #11, T1.6 #14; remaining T1.1/T1.3/T1.4/T1.5 are browser-verify).

Each item below needs a verification pass. "Unit-testable" = I can pin it headless; "browser" = needs Andrew's desktop.

| # | Fix | Where | Verify how |
|---|---|---|---|
| T1.1 | Scoped `ErrorBoundary` around BattleMap / TokenActionPanel / DiceTray | `client/.../ErrorBoundary.tsx`, AppShell, Sidebar, BottomBar | browser (force a panel throw) |
| T1.2 | ✅ Optimistic token-drag + **server-reject rollback** | `useDragToken.ts`, `server/.../tokenEvents.ts` | Merged in PR #10 with rollback tests plus hidden/invisible non-owner leak regression coverage; still worth a quick browser drag check |
| T1.3 | SessionLobby skeleton loaders | `SessionLobby.tsx` | browser |
| T1.4 | Modal a11y: focus-trap + ESC + ARIA (CharacterSheetFull, DiceTray, LootEditor) | `useFocusTrap.ts` + 3 modals | browser (keyboard nav) |
| T1.5 | On-blur form validation (ProfileModal, create/join session) | `ProfileModal.tsx`, `SessionLobby.tsx` | browser |
| T1.6 | ✅ `/state` ETag (304); `/bans` pagination accepted as won't-do | `server/.../sessions.ts`, `stateSnapshot.ts` | Merged in PR #14 with session-scoped ETags and regression tests |
| T1.7 | ✅ `customContent` validation 500→4xx + Zod `.errors`→`.issues` | `server/.../customContent.ts` | Merged in PR #11 with `handleDbError()` and SQLSTATE mapping tests |

> The user explicitly flagged: "we locked a ton of bugs, don't know if we tested all of them." T1.1–T1.7 are exactly that set. **These should be addressed (merged + verified) before being trusted in prod.**

---

## Tier 2 — performance / efficiency  (UX-perceived)

| # | Item | Status | Note |
|---|---|---|---|
| T2.1 | `TokenLayer` granular Zustand selectors (stop full re-render on any token change) | ✅ | Done in PR #89; layer now renders from a shallow-compared visible token-id list and sprites subscribe to their own token state |
| T2.2 | Off-canvas culling for Konva grid/background layers | ✅ | Done in PR #90; `GridLayer` already culled grid lines, and `BackgroundLayer` now crops the image/fill to the visible map rect |
| T2.3 | Defer Three.js dice-box bundle until first roll | ✅ | `Dice3DOverlay` is lazy-loaded from `AppShell` and dynamically imports `@3d-dice/dice-box` on first roll |
| T2.4 | Reduce `/state` poll churn when nothing changed | ✅ | heartbeat churn fixed in #3; `/state` ETag merged in #14 |
| T2.5 | Collapse `assertCharacterOwnerOrDM` 4 sequential queries → one CTE | ✅ | Done in PR #66; replaced sequential checks with one authorization query |
| T2.6 | Batch token-move broadcasts (one frame, N moves) | 🔶 | fan-out scoping/visibility centralized in #7; batching still open |
| T2.7 | `Cache-Control` on list endpoints (`/sessions/mine`, `/characters`, `/custom/*`) | ✅ | Done in PR #65; private no-store for user/session reads, short-lived public cache for compendium reads |

## Tier 3 — reliability / security

| # | Item | Status | Note |
|---|---|---|---|
| T3.1 | Lucia v3 deprecated → migration plan (Auth.js / Better-Auth / DIY) | ⬜ | no security patches incoming; not urgent |
| T3.2 | `npm audit fix` — 5 moderate vulns (uuid, express-rate-limit, postcss, brace-expansion) | ✅ | Done in PR #8; CI now runs `npm audit --audit-level=moderate` green |
| T3.3 | Boot-time config validation warnings | ✅ | Merged/deployed in PR #64; warns on missing OAuth provider or invalid production `BASE_URL` without blocking boot |
| T3.4 | Version/seq field for tokens + HP → detect concurrent writes | ⬜ | LWW currently silent |
| T3.5 | Await DB writes in `CombatService.applyDamage` (no fire-and-forget) | ✅ | Done in PR #88 for async HP mutation paths; `applyDamage`/`applyHeal` await combat-state, token-condition, and concentration persistence |
| T3.6 | Wrap character DDB import+merge in a transaction | ✅ | Done in PR #92; DDB import/sync and character JSON re-import lock existing rows with `FOR UPDATE` inside transactions, with rollback regression coverage |
| T3.7 | Tag `/state` snapshot with explicit `mapId` | ✅ | Done in PR #67; state payload carries map scope and client no longer infers empty snapshots from current map |
| T3.8 | Refactor opportunity-attack multi-tab fan-out logic | ⬜ | byzantine fallback path |

## Tier 4 — code quality / hygiene

| # | Item | Status | Note |
|---|---|---|---|
| T4.1 | Split `TokenActionPanel.tsx` (4877 lines) by domain | ⬜ | big mechanical refactor |
| T4.2 | Audit ~150 `as any` casts, add proper types | ⬜ | silent-failure risk |
| T4.3 | Pre-commit hooks (prettier + husky + lint-staged) + `.editorconfig` | ✅ | Done in PR #91; staged TS/JS files run Prettier + ESLint, staged JSON/CSS run Prettier, and lint globs use cross-shell double quotes |
| T4.4 | Vitest coverage thresholds on hot dirs (combat, dice, sockets) | ✅ | Done in PR #95; `npm run coverage` gates socket/combat/dice hot areas with baseline V8 thresholds |
| T4.5 | Enable `noUncheckedIndexedAccess` in `tsconfig.base.json` | ⬜ | |
| T4.6 | Decide Express v5 vs pin to v4 | ✅ | Express v5 is GA; server uses `express ^5.1.0` with `express@5.2.1` installed |
| T4.7 | Bring TSX into the global `npm run lint` gate | ⬜ | Current script misses `client/src/**/*.tsx`; direct TSX scan shows ~270 warnings, mostly `TokenActionPanel`, so clean in slices before flipping the gate |

---

## Operational / infra follow-ups

| # | Item | Status | Note |
|---|---|---|---|
| O.1 | Post-deploy verification: Discord OAuth, Google OAuth, char save round-trip, image upload round-trip, DGX Chronicle worker poll | ⬜ | needs new personal OAuth clients live + Andrew |
| O.2 | `UPLOAD_DIR` writes to local FS on Cloud Run — user uploads may not persist | ✅ | Done in PR #117; optional `UPLOAD_GCS_BUCKET` streams authorized uploads through `gs://atlas-bound-data-personal`, with local fallback for dev/tests |
| O.3 | Move secrets to Google Secret Manager (`--set-secrets`) | ⬜ | currently plain env vars on the revision |
| O.4 | Apple OAuth not plumbed through `deploy.sh` | ⬜ | defined in `.env.example`, decide if wanted |
| O.5 | Public static asset bucket + CORS strategy | ✅ | Done in PR #120; public assets now live in `atlas-bound-public-assets-personal`, runtime client URLs use it, and PNG/JPG/SVG/MP3 content types + CORS were verified |
| O.6 | Audit/migrate persisted DB URLs from old bucket (`atlas-bound-data`) to the new public asset bucket | ⬜ | Code still recognizes old URLs for backward compatibility, but DB rows may still point at the old seez.co bucket until audited/migrated |

## Websocket QA — remaining matrix rows

✅ Automated & merged: token-move hidden/map-scope/multi-tab fanout (#4).
✅ Automated & merged: ping / fog / zone scoping (#5).
✅ Automated & merged: token add/update visibility transitions (#7).

| Row | Status |
|---|---|
| `map:token-update` visibility promote/demote transitions | ✅ covered by #7 |
| Player ribbon activation + refresh returns to ribbon | 🔴 browser-only |
| Reconnect / membership (background-tab return, network reconnect, kick/ban no stale sockets) | 🔴 browser-only |
| Combat/spell recipient scoping (cast card, counterspell, shield, HP, conditions, death save, OA) | ✅ HP/conditions/death-save/reaction in #23; counterspell/Shield prompts covered by `combat-reaction-scoping`; cast VFX + counterspell/Shield responses + OA prompt fan-out covered in PR #68 |
| Music late-joiner sync; chat whisper/hidden-roll visibility | ✅ server regressions merged in #115; remaining browser-only smoke belongs in O.1 |

## Design / UX backlog (experience improvements — Claude's lane)

From a full design/UX review of all surfaces (lobby, in-session shell, canvas, combat/character panels, design-system + a11y), 2026-05. **Division of labour:** the D-series below are *make-it-better* tasks (Claude); functional *it's-broken* bugs the pass surfaced are listed at the end for CodeX's QA lane. **Awaiting CodeX (PM) review/agreement before work starts.**

### Brand & first impression
| # | Item | Sev | Note |
|---|---|---|---|
| D1 | ✅ Unify the brand name across all UI — product is "Atlas Bound", KBRT.AI remains parent/domain | 🔴 | Merged in PR #21 |
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
- **B-D1** ✅ `TokenActionPanel` spell cap fixed in PR #17 — 13+ leveled spells are selectable.
- **B-D2** ✅ Manual fog brush wired, persisted, tested, and deployed in PR #116.
- **B-D3** ✅ "Starting Map" picker fixed in PR #18 — selected preset creates and sets the starting map.
- **B-D4** ✅ `--text-muted` contrast fixed in PR #27 (also D19).

## Housekeeping

- Earlier dirty OAuth/Chronicle checkout note is superseded: this Mac checkout is clean as of the stabilization pass. Claude should still run `git status --short --branch` before starting local work.
- CodeX temporary review/deploy worktrees were removed after PR #3/#4/#5/#7. Keep temporary worktrees short-lived and remove them after merge/deploy.

---

## How this file is maintained

- Both agents update it as items change status; **CodeX (PM) sets priority and sequences**.
- When a PR lands an item, mark it ✅ with the PR number.
- New findings get appended under the right tier with a status icon.
- 🔶 items must be deduped against recent commits before work starts — `git log` the relevant file first.
