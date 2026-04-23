#!/usr/bin/env python3
"""
FLUX.2-dev batch generator for wiki detail images.

Reads `prompts.json` (same directory), generates one PNG per entry at
512x512, and writes to `out-wiki-flux2/<category>/<slug>.png`.

Meant to run on the DGX Spark after activating the image-gen venv:
    ssh dgx-ts   # or: ssh dgx  on office LAN
    cd ~/image-gen && source bin/activate
    cd ~/image-gen/batch
    # scp this script + prompts.json from the Mac first, then:
    python3 batch_gen_wiki.py

Skips any <category>/<slug>.png that already exists so reruns after
a crash or GCS upload are idempotent. Tune --categories / --only /
--force via CLI args (see argparse block at the bottom).

After generation:
    rsync -av out-wiki-flux2/ nas:/volume1/atlas-bound-mirror/wiki/
    # or gsutil -m cp -r out-wiki-flux2/* gs://atlas-bound-data/
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch
from diffusers import Flux2Pipeline

STYLE_SUFFIX = (
    ", Baldur's Gate 3 style stylized fantasy concept art, "
    "dark moody lighting, rich colors, rim light, painterly, "
    "cinematic, 4k, highly detailed"
)

NEGATIVE = "text, watermark, signature, logo, ugly, deformed, blurry, lowres, extra limbs"


def build_pipe() -> Flux2Pipeline:
    """Load FLUX.2-dev onto the best available CUDA device."""
    print("Loading FLUX.2-dev…", flush=True)
    pipe = Flux2Pipeline.from_pretrained(
        "black-forest-labs/FLUX.2-dev",
        torch_dtype=torch.bfloat16,
    )
    pipe.to("cuda")
    # Memory-saving settings pulled from our proven monster / spell
    # generation runs — keeps FLUX.2 comfortably inside 128 GB on the
    # DGX Spark even with parallel workloads.
    pipe.enable_attention_slicing()
    print("Pipeline ready.", flush=True)
    return pipe


def generate(pipe: Flux2Pipeline, prompt: str, out: Path, seed: int = 42) -> None:
    """Generate a single 512x512 image and save to `out`."""
    out.parent.mkdir(parents=True, exist_ok=True)
    generator = torch.Generator("cuda").manual_seed(seed)
    image = pipe(
        prompt=prompt + STYLE_SUFFIX,
        negative_prompt=NEGATIVE,
        height=512,
        width=512,
        num_inference_steps=28,
        guidance_scale=4.0,
        generator=generator,
    ).images[0]
    image.save(out)
    print(f"  ✓ {out}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--prompts",
        default=str(Path(__file__).parent / "prompts.json"),
        help="Path to prompts.json (defaults to sibling of this script).",
    )
    parser.add_argument(
        "--out-dir",
        default=str(Path.home() / "image-gen" / "out-wiki-flux2"),
        help="Output root directory.",
    )
    parser.add_argument(
        "--categories",
        nargs="*",
        default=None,
        help="Categories to generate (default: backgrounds feats conditions rules).",
    )
    parser.add_argument(
        "--only",
        nargs="*",
        default=None,
        help="Restrict to specific slugs (e.g. `--only alert lucky blinded`).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-generate even when the output PNG already exists.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="RNG seed (same slug + seed = same image).",
    )
    args = parser.parse_args()

    prompts_path = Path(args.prompts)
    out_root = Path(args.out_dir)
    if not prompts_path.exists():
        print(f"prompts.json not found at {prompts_path}", file=sys.stderr)
        return 2

    manifest = json.loads(prompts_path.read_text())
    allowed_categories = set(args.categories) if args.categories else {
        "backgrounds", "feats", "conditions", "rules",
    }
    allowed_slugs = set(args.only) if args.only else None

    # Count up front so the operator sees a total before we load FLUX.
    to_do: list[tuple[str, str, str]] = []
    for cat, entries in manifest.items():
        if cat.startswith("_"):
            continue
        if cat not in allowed_categories:
            continue
        for entry in entries:
            slug = entry["slug"]
            prompt = entry["prompt"]
            if allowed_slugs is not None and slug not in allowed_slugs:
                continue
            out = out_root / cat / f"{slug}.png"
            if out.exists() and not args.force:
                print(f"  · skip (exists) {out}", flush=True)
                continue
            to_do.append((cat, slug, prompt))

    if not to_do:
        print("Nothing to generate.", flush=True)
        return 0

    print(f"Will generate {len(to_do)} images.", flush=True)
    pipe = build_pipe()
    for i, (cat, slug, prompt) in enumerate(to_do, 1):
        out = out_root / cat / f"{slug}.png"
        print(f"[{i}/{len(to_do)}] {cat}/{slug}", flush=True)
        # Seed off a stable slug hash so each slug is reproducible but
        # different slugs don't share seed-induced sameness.
        seed = args.seed + sum(ord(c) for c in slug) * 31
        generate(pipe, prompt, out, seed=seed)

    print("Done.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
