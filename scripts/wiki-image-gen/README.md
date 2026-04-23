# Wiki detail-image generation

Generates FLUX.2-dev artwork for the wiki detail-popup hero strips
covering backgrounds, feats, conditions, and rules (~57 images).
Classes and races already have GCS artwork; the detail popup reuses
the card image.

## One-shot: push + run on DGX

Tailscale SSH needs a one-time browser login. Click the URL that
`ssh dgx-ts` prints on first connect (from a signed-in Tailscale
device), then:

```bash
# From Mac
cd "/Users/andrewkabrit/Projects/Claude code projects/dnd-vtt/scripts/wiki-image-gen"
scp prompts.json batch_gen_wiki.py dgx-ts:~/image-gen/batch/

# Kick off the job (detached, logs to ~/image-gen/out-wiki-flux2/run.log)
ssh dgx-ts 'cd ~/image-gen && source bin/activate && \
  cd batch && nohup python3 batch_gen_wiki.py \
    > ~/image-gen/out-wiki-flux2-run.log 2>&1 &'

# Tail progress
ssh dgx-ts 'tail -f ~/image-gen/out-wiki-flux2-run.log'
```

At 28 steps / 512×512 on FLUX.2-dev that's ~30s per image → roughly
30 minutes wall time for the full batch.

## Re-running a subset

```bash
# Just conditions
ssh dgx-ts 'cd ~/image-gen/batch && python3 batch_gen_wiki.py --categories conditions'

# Specific slugs
ssh dgx-ts 'cd ~/image-gen/batch && python3 batch_gen_wiki.py --only alert lucky blinded'

# Force-regen (ignores existing outputs)
ssh dgx-ts 'cd ~/image-gen/batch && python3 batch_gen_wiki.py --force'
```

## Upload to GCS

The client reads from `https://storage.googleapis.com/atlas-bound-data/<category>/<slug>.png`
via the `getXxxImageUrl` helpers in
`client/src/utils/compendiumIcons.ts`. After the batch finishes:

```bash
ssh dgx-ts 'gsutil -m cp -r ~/image-gen/out-wiki-flux2/* gs://atlas-bound-data/'
```

Or mirror to the NAS first if you want a local copy:

```bash
ssh dgx-ts 'rsync -av ~/image-gen/out-wiki-flux2/ nas:/volume1/atlas-bound-mirror/wiki/'
```

## What to expect

- `out-wiki-flux2/backgrounds/` → 13 PNGs (acolyte, charlatan, …, urchin)
- `out-wiki-flux2/feats/` → 14 PNGs (alert, great-weapon-master, …)
- `out-wiki-flux2/conditions/` → 15 PNGs (blinded, charmed, …, exhaustion)
- `out-wiki-flux2/rules/` → 16 PNGs (advantage-disadvantage, action, …)

Style target: **Baldur's Gate 3 stylized fantasy concept art**, dark
moody lighting, rich colors, rim light, painterly, cinematic — same
aesthetic as the existing tokens + spell art.

## Editing prompts

`prompts.json` has a flat structure per category. Tweak a prompt
then rerun with `--only <slug> --force`:

```bash
# Edit prompts.json locally, re-upload, regenerate
scp prompts.json dgx-ts:~/image-gen/batch/
ssh dgx-ts 'cd ~/image-gen/batch && python3 batch_gen_wiki.py --only charlatan --force'
```

## Why the detail popup doesn't crash when images are missing

`RuleOrConditionDetail` renders the hero `<img>` with an `onError`
handler that swaps to the matching `getXxxIconUrl` SVG fallback
(initial letter on a category-colored circle). So you can ship the
code without images, then light them up one category at a time as
the DGX batch finishes. No redeploy needed — just GCS uploads.

## Stable seeds

The script derives a per-slug seed from `base_seed + hash(slug)` so
each slug reproduces identically across runs. Bump `--seed` if you
want a fresh variation pass.
