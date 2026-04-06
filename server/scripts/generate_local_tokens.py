#!/usr/bin/env python3
"""
Generate creature token art locally using Stable Diffusion XL on Apple Silicon (MPS).
Runs entirely on your M3 Max GPU — no API costs.

Usage:
  cd /path/to/dnd-vtt
  source .venv/bin/activate
  python server/scripts/generate_local_tokens.py
  python server/scripts/generate_local_tokens.py --limit 30 --source "5e Core Rules"
  python server/scripts/generate_local_tokens.py --dry-run  # preview prompts without generating
"""
import argparse
import os
import sys
import time
import sqlite3

# Parse args before heavy imports
parser = argparse.ArgumentParser(description="Generate creature token art locally")
parser.add_argument("--limit", type=int, default=999, help="Max images to generate this run")
parser.add_argument("--source", type=str, default=None, help="Filter by source book (e.g. '5e Core Rules')")
parser.add_argument("--dry-run", action="store_true", help="Print prompts without generating")
parser.add_argument("--steps", type=int, default=20, help="Inference steps (more=better, slower)")
parser.add_argument("--size", type=int, default=512, help="Image size in pixels")
args = parser.parse_args()

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(PROJECT_ROOT, "server", "data", "dnd-vtt.db")
TOKENS_DIR = os.path.join(PROJECT_ROOT, "server", "uploads", "tokens")

os.makedirs(TOKENS_DIR, exist_ok=True)

# --- Prompt engineering ---
TYPE_HINTS = {
    "Aberration": "alien tentacled eldritch horror with otherworldly features, glowing eyes",
    "Beast": "fierce wild animal creature, realistic fur and scales, sharp teeth",
    "Celestial": "radiant divine angelic being with golden holy light, glowing aura",
    "Construct": "animated golem made of stone or metal, glowing runes etched on body",
    "Dragon": "a dragon with scales, horned head, fierce glowing eyes, powerful",
    "Elemental": "elemental being of raw magical energy, swirling aura",
    "Fey": "ethereal fey creature with mystical features, forest spirit",
    "Fiend": "demonic fiendish creature with horns, hellfire eyes, dark presence",
    "Giant": "towering massive giant with weathered skin, imposing",
    "Humanoid": "wearing armor, detailed face, wielding weapons",
    "Monstrosity": "monstrous unnatural beast with fangs and claws, terrifying",
    "Ooze": "translucent amorphous ooze creature, dripping, objects visible inside",
    "Plant": "living plant creature with vines, thorns, mossy texture",
    "Undead": "undead with rotting features, glowing eyes in hollow sockets, skeletal",
}

SIZE_DESC = {
    "Tiny": "tiny",
    "Small": "small",
    "Medium": "",
    "Large": "large imposing",
    "Huge": "huge towering",
    "Gargantuan": "massive gargantuan colossal",
}

# Matches the original Gemini prompt style that produced great results
PROMPT_SUFFIX = ", circular token portrait, dark fantasy style, detailed illustration, dark background, centered face/body, D&D character token, no text, no border decorations"

def build_prompt(name, creature_type, size):
    size_adj = SIZE_DESC.get(size, "")
    type_desc = TYPE_HINTS.get(creature_type, "fantasy creature")
    prefix = f"A {size_adj} {name}, {type_desc}" if size_adj else f"A {name}, {type_desc}"
    return prefix + PROMPT_SUFFIX

NEGATIVE = (
    "text, watermark, signature, words, letters, blurry, low quality, deformed, ugly, "
    "frame, border, multiple creatures, white background, bright cheerful, cartoon, anime, "
    "out of frame, cropped, extra limbs"
)

def slug_to_filename(name):
    import re
    slug = name.lower().replace(" ", "-")
    slug = re.sub(r"[^a-z0-9-]", "", slug)
    return slug

# --- DB queries ---
def get_pending_creatures(limit, source_filter=None):
    conn = sqlite3.connect(DB_PATH)
    query = """
        SELECT slug, name, type, size FROM compendium_monsters
        WHERE token_image_source = 'generated'
    """
    params = []
    if source_filter:
        query += " AND source = ?"
        params.append(source_filter)
    query += """
        ORDER BY
            CASE source WHEN '5e Core Rules' THEN 0 ELSE 1 END,
            cr_numeric ASC, name ASC
        LIMIT ?
    """
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [{"slug": r[0], "name": r[1], "type": r[2], "size": r[3]} for r in rows]

def count_remaining(source_filter=None):
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT COUNT(*) FROM compendium_monsters WHERE token_image_source = 'generated'"
    params = []
    if source_filter:
        query += " AND source = ?"
        params.append(source_filter)
    count = conn.execute(query, params).fetchone()[0]
    conn.close()
    return count

def mark_generated(slug):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE compendium_monsters SET token_image_source = 'ai-generated' WHERE slug = ?", (slug,))
    conn.commit()
    conn.close()

# --- Main ---
def main():
    creatures = get_pending_creatures(args.limit, args.source)
    remaining = count_remaining(args.source)

    print(f"=== Local Creature Token Generator (SDXL on MPS) ===")
    print(f"Pending: {len(creatures)} this run, {remaining} total remaining")
    print(f"Size: {args.size}px, Steps: {args.steps}")
    print()

    if not creatures:
        print("Nothing to generate!")
        return

    if args.dry_run:
        for i, c in enumerate(creatures):
            prompt = build_prompt(c["name"], c["type"], c["size"])
            print(f"[{i+1}] {c['name']} ({c['type']}, {c['size']})")
            print(f"    {prompt[:100]}...")
            print()
        print(f"(Dry run — {len(creatures)} creatures would be generated)")
        return

    # Heavy imports only when actually generating
    print("Loading SDXL Turbo model (cached after first run)...")
    import torch
    from diffusers import AutoPipelineForText2Image

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Device: {device}")

    pipe = AutoPipelineForText2Image.from_pretrained(
        "stabilityai/sdxl-turbo",
        torch_dtype=torch.float16 if device == "mps" else torch.float32,
        variant="fp16" if device == "mps" else None,
    )
    pipe = pipe.to(device)
    pipe.set_progress_bar_config(disable=True)

    print(f"Model loaded! Starting generation...\n")

    success = 0
    failed = 0

    for i, c in enumerate(creatures):
        filename = slug_to_filename(c["name"]) + ".png"
        filepath = os.path.join(TOKENS_DIR, filename)

        # Skip if PNG already exists
        if os.path.exists(filepath):
            print(f"[{i+1}/{len(creatures)}] {c['name']} — PNG exists, skipping")
            mark_generated(c["slug"])
            success += 1
            continue

        prompt = build_prompt(c["name"], c["type"], c["size"])
        print(f"[{i+1}/{len(creatures)}] {c['name']} ({c['type']}, {c['size']})")

        try:
            start = time.time()
            # SDXL Turbo uses 4 steps and guidance_scale=0.0
            result = pipe(
                prompt=prompt,
                negative_prompt=NEGATIVE,
                num_inference_steps=4,
                guidance_scale=0.0,
                width=args.size,
                height=args.size,
            )
            image = result.images[0]
            image.save(filepath)
            elapsed = time.time() - start
            fsize = os.path.getsize(filepath) / 1024
            mark_generated(c["slug"])
            success += 1
            print(f"    Saved ({fsize:.0f} KB, {elapsed:.1f}s)")
        except Exception as e:
            failed += 1
            print(f"    FAILED: {e}")

    print(f"\n=== Done: {success} generated, {failed} failed ===")
    print(f"Remaining: {remaining - success} creatures still need art")

if __name__ == "__main__":
    main()
