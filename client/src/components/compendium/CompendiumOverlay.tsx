import { useState, useEffect } from 'react';
import { CompendiumDetailPopup } from './CompendiumDetailPopup';
import { resolveSpellSlug } from '../../utils/spell-aliases';
import type { CompendiumSearchResult } from '@dnd-vtt/shared';

/**
 * Global overlay that listens for 'open-compendium-detail' events
 * and opens the CompendiumDetailPopup for any monster/spell/item.
 */
export function CompendiumOverlay() {
  const [detail, setDetail] = useState<CompendiumSearchResult | null>(null);

  useEffect(() => {
    const handler = async (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.slug || !d?.category) return;

      // Named spell aliases (DDB names → SRD slug)
      const slug = d.category === 'spells' ? resolveSpellSlug(d.slug) : d.slug;

      // Try direct slug lookup in compendium first
      let resp = await fetch(`/api/compendium/${d.category}/${slug}`).catch(() => null);

      // If not found, try custom content endpoints
      if (!resp?.ok) {
        const customEndpoint = d.category === 'monsters' ? `/api/custom/monsters/${d.slug}`
          : d.category === 'spells' ? `/api/custom/spells/${d.slug}`
          : `/api/custom/items/${d.slug}`;
        resp = await fetch(customEndpoint).catch(() => null);
      }

      // If still not found, try searching by name
      if (!resp?.ok && d.name) {
        const searchResp = await fetch(`/api/compendium/search?q=${encodeURIComponent(d.name)}&category=${d.category}&limit=1`).catch(() => null);
        if (searchResp?.ok) {
          const data = await searchResp.json();
          if (data.results?.length > 0) {
            setDetail(data.results[0]);
            return;
          }
        }
      }

      if (resp?.ok) {
        const data = await resp.json();
        // Pass the RESOLVED slug (post-alias) so the popup's own re-fetch
        // hits the correct endpoint. Without this, the popup tries to
        // fetch the original DDB slug ("tashas-hideous-laughter") which
        // 404s and shows "Error: Not found".
        setDetail({
          slug,
          name: data.name || d.name || d.slug,
          category: d.category,
          snippet: '',
          cr: data.challengeRating || data.challenge_rating,
          level: data.level,
          rarity: data.rarity,
        });
      }
    };

    window.addEventListener('open-compendium-detail', handler);
    return () => window.removeEventListener('open-compendium-detail', handler);
  }, []);

  if (!detail) return null;

  return <CompendiumDetailPopup result={detail} onClose={() => setDetail(null)} />;
}
