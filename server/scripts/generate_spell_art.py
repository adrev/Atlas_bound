#!/usr/bin/env python3
"""
Generate spell art locally using SDXL Turbo on Apple Silicon (MPS).

Usage:
  cd /path/to/dnd-vtt
  source .venv/bin/activate
  python server/scripts/generate_spell_art.py
  python server/scripts/generate_spell_art.py --limit 50
  python server/scripts/generate_spell_art.py --dry-run
"""
import argparse
import os
import re
import time
import sqlite3

parser = argparse.ArgumentParser(description="Generate spell art locally")
parser.add_argument("--limit", type=int, default=9999, help="Max images to generate")
parser.add_argument("--source", type=str, default=None, help="Filter by source")
parser.add_argument("--dry-run", action="store_true", help="Preview prompts only")
parser.add_argument("--size", type=int, default=512, help="Image size in pixels")
args = parser.parse_args()

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(PROJECT_ROOT, "server", "data", "dnd-vtt.db")
SPELLS_DIR = os.path.join(PROJECT_ROOT, "server", "uploads", "spells")
os.makedirs(SPELLS_DIR, exist_ok=True)

# --- Prompt engineering per spell school ---
SCHOOL_PROMPTS = {
    "Abjuration": "protective magical shield, glowing ward runes, blue-white barrier energy",
    "Conjuration": "swirling magical portal, summoning circle, ethereal energy materializing",
    "Divination": "mystical all-seeing eye, crystal ball with visions, glowing arcane sight",
    "Enchantment": "hypnotic magical aura, shimmering mind-affecting energy, mesmerizing swirls",
    "Evocation": "explosive magical energy, elemental blast, raw arcane power unleashed",
    "Illusion": "shifting illusory images, mirror-like distortions, prismatic light bending",
    "Necromancy": "dark necrotic energy, skull motifs, sickly green-purple death magic",
    "Transmutation": "transforming matter, alchemical energy, objects morphing and changing shape",
}

LEVEL_INTENSITY = {
    0: "subtle cantrip magic, minor magical effect",
    1: "faint magical glow, minor spell effect",
    2: "moderate magical energy, visible spell effect",
    3: "strong magical aura, powerful spell effect",
    4: "intense magical energy, impressive spell manifestation",
    5: "very powerful magic, dramatic spell effect with strong aura",
    6: "extremely powerful magic, overwhelming arcane energy",
    7: "legendary spell power, reality-bending magical force",
    8: "near-divine magical power, cataclysmic arcane energy",
    9: "ultimate arcane power, world-shaking magical manifestation, godlike energy",
}

PROMPT_SUFFIX = ", dark fantasy spell icon, dark background, centered, detailed"
NEGATIVE = "text, watermark, words, blurry, low quality, deformed, white background, cartoon, anime, person, face"


def build_prompt(name, school, level, description=""):
    clean_name = re.sub(r'\s*\(.*?\)\s*', ' ', name).strip()
    school_desc = SCHOOL_PROMPTS.get(school, "arcane magical energy")

    # Extract first sentence of description for visual grounding
    visual_desc = ""
    if description:
        first_sentence = description.split('.')[0].strip() if '.' in description[:150] else description[:80].strip()
        # Keep it short to stay under 77 CLIP tokens
        if len(first_sentence) > 80:
            first_sentence = first_sentence[:80].rsplit(' ', 1)[0]
        visual_desc = first_sentence

    if visual_desc:
        return f"{clean_name}, {visual_desc}, {school_desc}{PROMPT_SUFFIX}"
    return f"{clean_name}, {school_desc}{PROMPT_SUFFIX}"


def slug_to_filename(slug):
    return re.sub(r"[^a-z0-9-]", "", slug.lower())


# --- DB ---
def get_pending_spells(limit, source_filter=None):
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT slug, name, school, level, description FROM compendium_spells WHERE 1=1"
    params = []
    if source_filter:
        query += " AND source = ?"
        params.append(source_filter)
    query += " ORDER BY CASE source WHEN '5e Core Rules' THEN 0 WHEN 'SRD' THEN 1 ELSE 2 END, level ASC, name ASC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [{"slug": r[0], "name": r[1], "school": r[2], "level": r[3], "description": r[4] or ""} for r in rows]


def count_total():
    conn = sqlite3.connect(DB_PATH)
    count = conn.execute("SELECT COUNT(*) FROM compendium_spells").fetchone()[0]
    conn.close()
    return count


# --- Main ---
def main():
    spells = get_pending_spells(args.limit, args.source)
    total = count_total()

    print(f"=== Local Spell Art Generator (SDXL on MPS) ===")
    print(f"Total spells: {total}, processing up to {len(spells)}")
    print(f"Size: {args.size}px")
    print()

    if not spells:
        print("Nothing to generate!")
        return

    if args.dry_run:
        for i, s in enumerate(spells[:20]):
            prompt = build_prompt(s["name"], s["school"], s["level"])
            print(f"[{i+1}] {s['name']} (Lv{s['level']} {s['school']})")
            print(f"    {prompt[:120]}...")
            print()
        if len(spells) > 20:
            print(f"... and {len(spells) - 20} more")
        return

    print("Loading SDXL Turbo model...")
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
    skipped = 0
    failed = 0

    for i, s in enumerate(spells):
        filename = slug_to_filename(s["slug"]) + ".png"
        filepath = os.path.join(SPELLS_DIR, filename)

        if os.path.exists(filepath):
            skipped += 1
            if skipped <= 3:
                print(f"[{i+1}/{len(spells)}] {s['name']} — exists, skipping")
            elif skipped == 4:
                print(f"    ... skipping existing files ...")
            continue

        prompt = build_prompt(s["name"], s["school"], s["level"], s.get("description", ""))
        print(f"[{i+1}/{len(spells)}] {s['name']} (Lv{s['level']} {s['school']})")

        try:
            start = time.time()
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
            success += 1
            print(f"    Saved ({fsize:.0f} KB, {elapsed:.1f}s)")
        except Exception as e:
            failed += 1
            print(f"    FAILED: {e}")

    print(f"\n=== Done: {success} generated, {skipped} skipped, {failed} failed ===")


if __name__ == "__main__":
    main()
