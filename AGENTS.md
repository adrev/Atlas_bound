# AGENTS.md — coordination contract for Atlas Bound

Two AI agents work this repo in tandem. **Both commit and act as `@adrev`** (one driven by Claude, one by CodeX), so GitHub authorship cannot tell us apart. The conventions below are how we stay out of each other's way.

## The two agents

| | **Claude** | **CodeX** |
|---|---|---|
| Runs on | Local — Claude Code on Andrew's Windows machine | Cloud — driven from Andrew's phone |
| Can reach | This machine + Tailscale (DGX/NAS/Mac), local Docker/Postgres, authed `gcloud` | The GitHub repo only |
| Branch prefix | `claude/*` | `codex/*` |
| Commit trailer | `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` | `Co-Authored-By: CodeX <codex@openai.com>` |
| Comment signature | `**[Claude → CodeX]**` | `**[CodeX → Claude]**` |

## Communication

The coordination inbox is **GitHub issue #1** ("🤝 Agent coordination"). It replaces an older MCP message bus that ran on the DGX (now offline). It is the single async channel both agents reach.

- **Send a message:** comment on issue #1, first line `**[<from> → <to>]** (fyi|needs-response|blocking)`.
- **Receive:** `gh issue view 1 --comments` at the start of every session and after each task.
- **Code review** happens on the PR, not the issue.
- Andrew can read/route the whole thing from his phone via the GitHub app.

## Lanes — who owns what

The split is **machine-tethered/infra/integration (Claude)** vs. **self-contained code that's drivable from a phone (CodeX)**.

**Claude owns:**
- Infra: `deploy.sh`, GCP, Cloud Run, Cloud SQL, domain mapping, CI.
- Anything needing the local machine or Tailscale stack (DGX worker, local Postgres/Docker, live smoke tests).
- `server/` + `shared/` backlog that needs live verification against the running stack.
- **Integration:** reviewing, merging, and deploying CodeX's PRs.

**CodeX owns:**
- Self-contained code backlog as discrete PRs: large mechanical refactors (e.g. splitting `TokenActionPanel.tsx`), the `as any` audit, `client/` performance (TokenLayer selectors, Konva off-canvas culling, Three.js lazy-load), and test coverage.

## Rules of engagement

1. **Branch-per-agent** (`claude/*` / `codex/*`). Never commit to `main` directly.
2. **PR to `main`** with a light review gate: don't merge anything touching `server/`, `deploy.sh`, or `shared/` without the other agent (or Andrew) glancing at it. Pure-`client/` PRs in CodeX's lane can move fast.
3. **CodeX never runs `gcloud` or `deploy.sh`.** Production deploys are Claude's, from the local machine. (If/when the auto-deploy CI is re-enabled, merging to `main` deploys — until then, ping Claude on issue #1.)
4. **`shared/` type changes:** announce on issue #1 before editing — a type change breaks both trees.
5. **Pull before work; push small and often.** `main` is the source of truth across Andrew's Mac, Windows PC, and CodeX's cloud sandboxes.
6. **Label PRs** with the originating agent in the title prefix (`[claude]` / `[codex]`) since the GitHub author is `adrev` for both.
