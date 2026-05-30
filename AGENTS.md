# AGENTS.md — coordination contract for Atlas Bound

Two AI agents work this repo in tandem. **Both commit and act as `@adrev`**, so GitHub authorship cannot tell us apart. The signatures and lanes below are how we stay coordinated.

## Operating Model

**CodeX is the PM and default point of contact.** Andrew can reach CodeX from his phone, so requests flow through CodeX by default. CodeX has final say on priority, scope, PR readiness, merge order, and what ships.

**Claude is the local executor and integration partner.** Claude runs only when Andrew is at the desk with the local machine. CodeX should queue machine-tethered work for Claude on issue #1 and Claude clears that queue when live.

## The Two Agents

| | **Claude** | **CodeX** |
|---|---|---|
| Role | Local executor and integration partner | PM, intake owner, final ship decision |
| Runs on | Claude Code on Andrew's local machine | Codex from Andrew's phone/Mac session |
| Can reach | Windows/local stack, Tailscale resources, local Docker/Postgres, desktop-only flows | GitHub, repo work, Andrew-facing coordination, and Mac/browser/cloud tools when available |
| Branch prefix | `claude/*` | `codex/*` |
| Commit trailer | `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` | `Co-Authored-By: CodeX <codex@openai.com>` |
| Comment signature | `**[Claude → CodeX]**` | `**[CodeX → Claude]**` |

## Communication

The coordination inbox is **GitHub issue #1** ("Agent coordination"). It is the single async channel both agents can reach.

- **Send a message:** comment on issue #1, first line `**[<from> → <to>]** (fyi|needs-response|blocking)`.
- **Receive:** check issue #1 at the start of every session and after each meaningful task.
- **Code review** happens on the PR, not the issue.
- **Handoffs** on issue #1 should include branch, PR, local state, verification run, deploy status, and exact next action.
- Andrew can read/route the whole thing from his phone via the GitHub app.

## Lanes

The split is pragmatic, not absolute. CodeX decides ownership per task and may take work outside the default CodeX lane when the current environment can safely do it. If CodeX cannot complete something because it needs Claude's machine, desktop state, local credentials, or Tailscale access, CodeX queues it for Claude.

**CodeX owns by default:**
- Andrew intake, prioritization, backlog shaping, and final ship calls.
- PR/issue triage, reviews, acceptance criteria, and merge sequencing.
- Self-contained code changes, tests, docs, and refactors.
- Security and QA review reports, with actionable prompts or delegated tasks.
- Mac/browser/cloud work when CodeX has active access and the action is safe to perform.

**Claude owns by default:**
- Work that requires Andrew's local machine, Windows-only desktop state, or local app/browser interaction unavailable to CodeX.
- Tailscale/DGX/NAS/local Docker/local Postgres verification.
- Production deploy execution when CodeX queues it or when local credentials/access make Claude the safer operator.
- Live smoke tests that require the local player/DM desktop setup.
- Integration help: reviewing CodeX PRs, resolving local conflicts, and reporting deploy/test results back on issue #1.

## Rules Of Engagement

1. **Branch-per-agent** (`claude/*` / `codex/*`). Do not commit directly to `main` unless Andrew explicitly asks for an emergency hotfix and the state is documented on issue #1.
2. **PR to `main`** for normal work. CodeX has final say on merge readiness, but any risky `server/`, `shared/`, auth, payment, deploy, data, or infra change should get either Claude's glance or explicit Andrew approval.
3. **Deploys are coordinated, not assumed.** CodeX may deploy only when it has the right environment and the action is intentional; otherwise CodeX queues deploys for Claude. Whoever deploys posts revision, URL, smoke result, and rollback notes on issue #1.
4. **`shared/` type changes:** announce on issue #1 before editing because they can break both trees.
5. **Pull before work; push small and often.** `main` is the source of truth across Andrew's Mac, Windows PC, and cloud sessions.
6. **Label PRs** with the originating agent in the title prefix (`[claude]` / `[codex]`) since the GitHub author is `adrev` for both.
7. **Do not overwrite the other agent's uncommitted or in-flight work.** If a task needs files the other agent is changing, stop and coordinate on issue #1.
8. **Keep issue #1 operational.** Use it for claims, blockers, handoffs, "main moved, pull", deploy queues, and final decisions. Keep long code review details on the relevant PR.
