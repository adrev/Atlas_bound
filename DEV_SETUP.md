# Atlas Bound — Dev Setup Guide (Mac + Windows)

Cross-platform instructions so you can switch between your Mac and Windows
PC and continue work seamlessly.

---

## Prerequisites (both platforms)

- **Node.js 20.x or 22.x** (LTS) — https://nodejs.org
- **Git** — https://git-scm.com
- **PostgreSQL 16+** running locally OR access to the Cloud SQL instance
- **gcloud CLI** (for deploys) — https://cloud.google.com/sdk
- **Tailscale** (for DGX/NAS access) — https://tailscale.com/download

## Repository

- **GitHub:** https://github.com/adrev/Atlas_bound
- **Branch:** `main` (push directly; this is a solo project)

---

## First-Time Setup — Mac

```bash
# 1. Clone
cd ~/Projects
git clone https://github.com/adrev/Atlas_bound.git dnd-vtt
cd dnd-vtt

# 2. Install dependencies (workspaces install everything)
npm install

# 3. Copy env template and fill in secrets
cp server/.env.example server/.env
# Edit server/.env with your OAuth secrets, Postgres URL, etc.
# (For local dev, you can leave OAuth empty and use email/password auth)

# 4. Start Postgres locally if not running
brew services start postgresql@16

# 5. Run dev server (client + server concurrently)
npm run dev
# Client at http://localhost:5173
# Server at http://localhost:3001
```

## First-Time Setup — Windows

Open **PowerShell** (not CMD):

```powershell
# 1. Clone
cd $HOME
git clone https://github.com/adrev/Atlas_bound.git dnd-vtt
cd dnd-vtt

# 2. Install dependencies
npm install

# 3. Copy env template (PowerShell syntax)
Copy-Item server\.env.example server\.env
# Edit server\.env in your editor (notepad, VS Code, etc.)

# 4. Start Postgres (install from https://www.postgresql.org/download/windows/)
# Service should auto-start. Verify:
Get-Service postgresql*

# 5. Run dev server
npm run dev
```

**Windows-specific gotchas:**
- Use **PowerShell**, not CMD — CMD doesn't handle `&&` the same way and
  npm scripts may misbehave.
- If you see `'concurrently' is not recognized`, run `npm install` again.
- If port 3001 or 5173 is in use, change `PORT=` in `server\.env` and
  update `vite.config.ts` if needed.

---

## Daily Workflow (both platforms)

```bash
# Pull latest before starting
git pull

# Make changes, test locally
npm run dev

# Before committing
npm run lint        # ESLint, must be clean
npm run test        # Vitest, must pass
npm run build       # tsc + Vite build, must succeed

# Commit and push
git add -A
git commit -m "your message"
git push
```

## Switching Between Mac and Windows

The repo is the single source of truth. **Always pull before starting**
and **always push before stopping** so the other machine sees your work.

```bash
# When stopping work:
git add -A && git commit -m "WIP: <what you were doing>" && git push

# When starting on the other machine:
git pull
```

Local state that doesn't sync via git:
- `server/.env` — secrets, copy from `.env.example` and refill on each machine
- `client/node_modules/` and `server/node_modules/` — run `npm install` after pull
- Local Postgres data — see "Database" section below
- Claude Code conversations (`~/.claude/`) — per-machine, won't sync

---

## Database

Two options:

### Option A — Shared Cloud SQL (recommended)
You point both machines at the same Postgres instance on GCP. Your data
is identical on both. Set in `server/.env`:
```
DATABASE_URL=postgresql://user:pass@HOST:5432/dbname
```
For GCP Cloud SQL access, use the Cloud SQL Auth Proxy:
- Mac: `brew install --cask google-cloud-sdk` then `gcloud sql connect atlas-bound-db`
- Windows: Install gcloud from the link above, same command

### Option B — Local Postgres per machine
Each machine has its own data. Useful for experimenting without affecting
the other machine. The `initDatabase()` function in `server/src/db/schema.ts`
auto-creates all tables on first boot.

---

## Tailscale (Remote Access to DGX / NAS)

Tailscale is already installed on Mac, Windows PC, DGX, and Asustor NAS.
Use the aliases on Mac (in `~/.ssh/config`):

| Command | Target |
|---------|--------|
| `ssh dgx-ts` | DGX Spark (anywhere) |
| `ssh win-pc` | Windows PC (anywhere) |
| `ssh nas-ts` | Asustor NAS (anywhere) |

On Windows, use the Tailscale IPs directly via PowerShell:
```powershell
ssh andrew@100.117.164.2     # DGX
ssh andrew@100.79.160.73      # NAS
ssh andrewkabrit@100.79.160.99 # Mac
```

Add aliases to `$HOME\.ssh\config` (same syntax as Linux/Mac) so you can
just type `ssh dgx-ts` on Windows too.

---

## Deploy to Production

```bash
./deploy.sh
```

Builds the Docker image, pushes to GCR, deploys to Cloud Run.
**Requires:** gcloud authenticated as `andrew@seez.co` and project set to
`atlas-bound`. Works from Mac and Windows (use Git Bash on Windows for
the shell script, or port it to PowerShell).

---

## Project Layout

```
dnd-vtt/
├── client/          # React + Vite + Konva canvas frontend
│   ├── src/
│   │   ├── components/   # UI components (layout, canvas, combat, etc.)
│   │   ├── stores/       # Zustand state stores
│   │   ├── socket/       # Socket.IO client + listeners
│   │   ├── utils/        # Helpers (dice, slug, icons, etc.)
│   │   └── styles/       # Theme + globals
├── server/          # Node + Express + Socket.IO backend
│   ├── src/
│   │   ├── routes/       # REST endpoints
│   │   ├── socket/       # Socket.IO handlers
│   │   ├── services/     # Domain services (combat, dice, etc.)
│   │   ├── auth/         # Lucia auth + OAuth
│   │   ├── db/           # Schema + connection
│   │   └── utils/        # Authorization, validation, etc.
├── shared/          # Types + utilities shared by client and server
│   └── src/
│       ├── types/        # TypeScript interfaces
│       └── utils/        # Pure functions (dice parser, etc.)
├── deploy.sh        # Cloud Run deploy script
└── DEV_SETUP.md     # This file
```

---

## Common Tasks

**Run only client:** `npm run dev --workspace=client`
**Run only server:** `npm run dev --workspace=server`
**Run a single test file:** `npx vitest run path/to/file.test.ts`
**Check what's deployed:** `curl https://kbrt.ai/readyz`
**See current revision:** `gcloud run revisions list --service atlas-bound --region us-central1 --limit 5`
**Roll back:** `gcloud run services update-traffic atlas-bound --to-revisions=atlas-bound-XXXXX-xxx=100 --region us-central1`
