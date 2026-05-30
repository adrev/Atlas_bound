# Atlas Bound — Chronicle Worker (DGX edition)

Polls Cloud Run for pending Chronicle jobs and runs them through
Ollama-served Gemma 4 on the DGX (or any host with Ollama). Replaces
the Vertex AI inline path when `CHRONICLER_BACKEND=ollama` is set on
Cloud Run.

## Why this exists

Cloud Run can't reach the DGX over Tailscale natively, so the polling
direction is inverted: the DGX initiates outbound HTTPS to
`dnd.kbrt.ai/api/internal/chronicle/jobs/claim`, processes whatever
work is waiting, and posts results back. No tunnel, no firewall
holes, no userspace Tailscale inside the container.

## What it costs

Power only. With `gemma4:26b` (MoE — 25.2B total / 3.8B active per
token) on a GB10, a typical recap takes ~3–6 seconds of GPU time at
~80–120 tok/s output. Idle power ~50 W; generating ~150 W. At
$0.15/kWh and modest usage, the worker costs cents per month.

## Install (DGX)

> Run **once** on the DGX. The worker survives reboots via systemd.

```bash
# 1. Make sure Ollama is current (≥0.22 for Gemma 4 support)
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl restart ollama

# 2. Pull the model — ~17 GB download, runs once
ollama pull gemma4:26b

# 3. Stage the worker
sudo mkdir -p /home/andrew/atlas-chronicle-worker
sudo chown andrew:andrew /home/andrew/atlas-chronicle-worker
# Copy worker.mjs + atlas-chronicle.service from this repo onto the DGX:
#   scp dgx-worker/worker.mjs            dgx:/home/andrew/atlas-chronicle-worker/
#   scp dgx-worker/atlas-chronicle.service dgx:/tmp/

# 4. Drop in the env file
cat > /home/andrew/atlas-chronicle-worker/worker.env <<'EOF'
ATLAS_BASE_URL=https://dnd.kbrt.ai
CHRONICLE_WORKER_TOKEN=<paste-the-shared-secret-here>
OLLAMA_URL=http://127.0.0.1:11434
CHRONICLER_OLLAMA_MODEL=gemma4:26b
POLL_INTERVAL_MS=5000
EOF
chmod 600 /home/andrew/atlas-chronicle-worker/worker.env

# 5. Install + start the systemd unit
sudo mv /tmp/atlas-chronicle.service /etc/systemd/system/atlas-chronicle.service
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-chronicle.service

# 6. Watch it run
sudo journalctl -u atlas-chronicle.service -f
# (or tail the log file)
sudo tail -f /var/log/atlas-chronicle-worker.log
```

## Required env vars

| Variable | Default | Purpose |
|---|---|---|
| `ATLAS_BASE_URL` | `https://dnd.kbrt.ai` | Where the worker polls for jobs |
| `CHRONICLE_WORKER_TOKEN` | *(required)* | Shared secret — must match the same env var on Cloud Run |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama daemon |
| `CHRONICLER_OLLAMA_MODEL` | `gemma4:26b` | Pull a different variant (`e4b`, `31b`) by setting this |
| `POLL_INTERVAL_MS` | `5000` | Sleep between empty-claim ticks |

## Switching the backend

The Cloud Run server defaults to Vertex AI. To activate the DGX path,
set on Cloud Run:

```
CHRONICLER_BACKEND=ollama
CHRONICLE_WORKER_TOKEN=<same secret as the worker>
```

The worker can be running before or after the flip — whichever
backend is set decides which path takes new chronicle generations.

## Failure modes (and what happens)

| Scenario | Behavior |
|---|---|
| DGX offline | Pending jobs queue up in `chronicle_entries.status='pending'`. When the DGX comes back, the worker drains the backlog. |
| Worker crashes mid-job | The row is stuck at `status='generating'`. Manual recovery: `UPDATE chronicle_entries SET status='pending' WHERE status='generating' AND generation_started_at < NOW() - INTERVAL '10 minutes'`. (TODO: add a stale-job sweeper to the cron.) |
| Ollama call fails | Worker posts `{ error, hint }`; row goes to `status='failed'` with the error message. DM can hit Retry from the modal. |
| Worker token mismatch | All claims/results return 401. Worker logs the failure and keeps polling — no work happens until the token is fixed. |
| Cloud Run rotates secrets | Update `worker.env` on the DGX, `sudo systemctl restart atlas-chronicle.service`. |

## Smoke test

After install, generate a chronicle from the lobby (or use curl to
POST to /api/sessions/:id/chronicle/generate). Within ~10 seconds the
worker log should show:

```
[2026-04-29T...] claimed job <uuid> — "<Campaign>" #<n> (<chars> chars)
  → ok in <ms>ms (recap <chars> chars, <n> entities)
```

And the row will flip from `pending` → `generating` → `draft` in the
DB. The DM's modal will auto-poll and surface the draft for review.
