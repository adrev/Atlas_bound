import { useEffect, useRef, useState, useMemo } from 'react';
import { Layer, Group, Circle, Rect, Text, Ring, Shape } from 'react-konva';
import type { Token } from '@dnd-vtt/shared';
import { useMapStore } from '../../../stores/useMapStore';
import { useCombatStore } from '../../../stores/useCombatStore';
import { useSessionStore } from '../../../stores/useSessionStore';
import { useCharacterStore } from '../../../stores/useCharacterStore';
import { useDragToken } from '../../../hooks/useDragToken';
import { emitCharacterUpdate, emitDamage, emitHeal } from '../../../socket/emitters';
import { theme } from '../../../styles/theme';

function TokenImage({ url, size }: { url: string; size: number }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const urlRef = useRef(url);

  useEffect(() => {
    urlRef.current = url;
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (urlRef.current === url) setImage(img);
    };
    img.onerror = () => {
      // Fallback: no image
      if (urlRef.current === url) setImage(null);
    };
    img.src = url;
    return () => { img.onload = null; img.onerror = null; };
  }, [url]);

  if (!image) return <Circle radius={size / 2} fill="#555" />;

  // Draw the image cropped to a circle using a Shape with custom sceneFunc
  return (
    <Shape
      sceneFunc={(ctx) => {
        // Draw circular clip
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2, false);
        ctx.closePath();
        ctx.clip();

        // Draw image centered and scaled to cover the circle
        const imgW = image.width;
        const imgH = image.height;
        const cropSize = Math.min(imgW, imgH);
        const sx = (imgW - cropSize) / 2;
        const sy = (imgH - cropSize) / 2;
        ctx.drawImage(image, sx, sy, cropSize, cropSize, -size / 2, -size / 2, size, size);
      }}
      width={size}
      height={size}
    />
  );
}

interface TokenSpriteProps {
  token: Token;
  isSelected: boolean;
  isCurrentTurn: boolean;
}

function TokenSprite({ token, isSelected, isCurrentTurn }: TokenSpriteProps) {
  const { draggable, onDragEnd, onDragMove } = useDragToken(token.id);
  const selectToken = useMapStore((s) => s.selectToken);
  const setHoveredToken = useMapStore((s) => s.setHoveredToken);
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);

  const tokenSize = gridSize * token.size;
  const allChars = useCharacterStore((s) => s.allCharacters);

  // Compute HP ratio from character store or combatant data
  const charData = token.characterId ? allChars[token.characterId] : null;
  const charHp = charData?.hitPoints ?? null;
  const charMaxHp = charData?.maxHitPoints ?? null;

  // Look up combatant HP
  const combatants = useCombatStore((s) => s.combatants);
  const combatant = useMemo(
    () => combatants.find((c) => c.tokenId === token.id),
    [combatants, token.id]
  );
  // HP ratio: prefer combatant (combat), then character store, then 1 (full)
  const actualHpRatio = combatant
    ? Math.max(0, combatant.hp / Math.max(1, combatant.maxHp))
    : (charHp !== null && charMaxHp !== null && charMaxHp > 0)
      ? Math.max(0, charHp / charMaxHp)
      : 1;
  const showHpBar = combatant || (charHp !== null && charMaxHp !== null && charHp < charMaxHp);

  const hpColor =
    actualHpRatio > 0.5
      ? theme.hp.full
      : actualHpRatio > 0.25
      ? theme.hp.half
      : theme.hp.low;

  const conditionColors: Record<string, string> = {
    blinded: '#4a4a4a',
    charmed: '#ff69b4',
    deafened: '#7f8c8d',
    frightened: '#9b59b6',
    grappled: '#e67e22',
    incapacitated: '#95a5a6',
    invisible: '#3498db',
    paralyzed: '#f1c40f',
    petrified: '#7f8c8d',
    poisoned: '#27ae60',
    prone: '#d35400',
    restrained: '#c0392b',
    stunned: '#f39c12',
    unconscious: '#2c3e50',
  };

  const isDM = useSessionStore.getState().isDM;

  // Death state
  const isDead = (charHp !== null && charHp <= 0) || (combatant && combatant.hp <= 0);
  const isNPC = !token.ownerUserId;

  // Visibility state — DM sees invisible tokens dimmed so they can still
  // be moved/managed but it's clear they're hidden from players
  const tokenConditions = (token.conditions || []) as string[];
  const isInvisible = tokenConditions.includes('invisible') && !tokenConditions.includes('outlined');

  // Compute opacity:
  //   • Dead → 40%
  //   • DM viewing a hidden token → 30%
  //   • DM viewing an invisible token → 50% (still visible to DM)
  //   • Otherwise → 100%
  let groupOpacity = 1;
  if (isDead) groupOpacity = 0.4;
  else if (isDM && !token.visible) groupOpacity = 0.3;
  else if (isDM && isInvisible) groupOpacity = 0.5;

  return (
    <Group
      x={token.x}
      y={token.y}
      opacity={groupOpacity}
      draggable={draggable && !isDead}
      onDragEnd={onDragEnd}
      onDragMove={onDragMove}
      onClick={() => {
        const state = useMapStore.getState();
        console.log('[TOKEN CLICK]', token.name, 'isTargeting:', state.isTargeting, 'targetingData:', state.targetingData?.spell?.name || state.targetingData?.weapon?.name || 'none');
        if (state.isTargeting) {
          console.log('[TOKEN CLICK] Dispatching target-token-selected for', token.name, token.id);
          window.dispatchEvent(new CustomEvent('target-token-selected', {
            detail: { tokenId: token.id }
          }));
          return;
        }
        selectToken(token.id);
      }}
      onTap={() => {
        const { isTargeting } = useMapStore.getState();
        if (isTargeting) {
          window.dispatchEvent(new CustomEvent('target-token-selected', {
            detail: { tokenId: token.id }
          }));
          return;
        }
        selectToken(token.id);
      }}
      onContextMenu={(e) => {
        e.evt.preventDefault();
        e.evt.stopPropagation();
        const stage = e.target.getStage();
        if (stage) {
          const container = stage.container().getBoundingClientRect();
          const pointer = stage.getPointerPosition();
          if (pointer) {
            useMapStore.getState().setContextMenu(token.id, {
              x: pointer.x + container.left,
              y: pointer.y + container.top,
            });
          }
        }
      }}
      onWheel={(e) => {
        // Scroll on token to adjust HP (DM or owner only)
        const isDM = useSessionStore.getState().isDM;
        const isOwner = token.ownerUserId === useSessionStore.getState().userId;
        if (!isDM && !isOwner) return;
        e.evt.preventDefault();
        e.evt.stopPropagation();
        const delta = e.evt.deltaY < 0 ? 1 : -1; // scroll up = heal, down = damage
        if (token.characterId) {
          const char = useCharacterStore.getState().allCharacters[token.characterId];
          if (char) {
            const newHp = Math.max(0, Math.min(char.maxHitPoints, char.hitPoints + delta));
            if (newHp !== char.hitPoints) {
              emitCharacterUpdate(token.characterId, { hitPoints: newHp });
            }
          }
        } else if (combatant) {
          // In combat, use combat damage/heal
          if (delta > 0) emitHeal(token.id, 1);
          else emitDamage(token.id, 1);
        }
      }}
      onMouseEnter={(e) => {
        if (useMapStore.getState().isTargeting) {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'crosshair';
        }
        const stage = e.target.getStage();
        if (stage) {
          const pointer = stage.getPointerPosition();
          if (pointer) {
            const container = stage.container().getBoundingClientRect();
            setHoveredToken(token.id, {
              x: pointer.x + container.left,
              y: pointer.y + container.top,
            });
          }
        }
      }}
      onMouseLeave={() => {
        setHoveredToken(null);
      }}
    >
      {/* Current turn glow */}
      {isCurrentTurn && (
        <Circle
          radius={tokenSize / 2 + 6}
          fill="transparent"
          stroke={theme.gold.primary}
          strokeWidth={3}
          opacity={0.7}
          shadowColor={theme.gold.primary}
          shadowBlur={15}
          shadowEnabled
        />
      )}

      {/* Selection ring */}
      {isSelected && !isCurrentTurn && (
        <Ring
          innerRadius={tokenSize / 2 + 2}
          outerRadius={tokenSize / 2 + 5}
          fill={theme.blue}
          opacity={0.6}
        />
      )}

      {/* Token visual */}
      {token.imageUrl ? (
        <TokenImage url={token.imageUrl} size={tokenSize} />
      ) : (
        <Circle radius={tokenSize / 2} fill={token.color || '#666'} />
      )}

      {/* Token border - green for player-owned, red for NPC/enemy, blue if selected */}
      <Circle
        radius={tokenSize / 2}
        stroke={
          isSelected ? theme.blue
          : token.ownerUserId ? '#45a049'
          : '#c53131'
        }
        strokeWidth={isSelected ? 3 : 2}
        fill="transparent"
      />

      {/* Skull overlay for dead tokens */}
      {isDead && (
        <Group>
          <TokenImage url="/uploads/tokens/skull.png" size={tokenSize * 0.7} />
        </Group>
      )}

      {/* HP bar (above token) - shows during combat OR when damaged */}
      {showHpBar && (
        <Group y={-tokenSize / 2 - 8}>
          <Rect
            x={-tokenSize / 2 + 4}
            y={0}
            width={tokenSize - 8}
            height={4}
            fill="rgba(0,0,0,0.6)"
            cornerRadius={2}
          />
          <Rect
            x={-tokenSize / 2 + 4}
            y={0}
            width={Math.max(0, (tokenSize - 8) * actualHpRatio)}
            height={4}
            fill={hpColor}
            cornerRadius={2}
          />
        </Group>
      )}

      {/* Name label background + text (below token) */}
      {(() => {
        const labelWidth = Math.max(tokenSize + 20, Math.min(token.name.length * 6.5 + 16, 160));
        const needsWrap = token.name.length > (tokenSize + 20) / 6;
        const labelHeight = needsWrap ? 26 : 16;
        return (
          <>
            <Rect
              x={-labelWidth / 2}
              y={tokenSize / 2 + 2}
              width={labelWidth}
              height={labelHeight}
              fill="rgba(0,0,0,0.75)"
              cornerRadius={4}
            />
            <Text
              text={token.name}
              y={tokenSize / 2 + 3}
              x={-labelWidth / 2}
              width={labelWidth}
              align="center"
              fontSize={10}
              fontStyle="bold"
              fill="#eee"
              wrap="word"
              shadowColor="black"
              shadowBlur={3}
              shadowOffset={{ x: 0, y: 1 }}
              shadowEnabled
            />
          </>
        );
      })()}

      {/* DEAD label */}
      {isDead && (
        <Text
          text="DEAD"
          y={tokenSize / 2 + (token.name.length > (tokenSize + 20) / 6 ? 28 : 18)}
          x={-30}
          width={60}
          align="center"
          fontSize={9}
          fontStyle="bold"
          fill="#c53131"
        />
      )}

      {/* Condition badges */}
      {token.conditions.length > 0 && (
        <Group y={tokenSize / 2 + 20}>
          {token.conditions.slice(0, 4).map((cond, i) => (
            <Circle
              key={cond}
              x={-((token.conditions.length - 1) * 8) / 2 + i * 8}
              y={0}
              radius={4}
              fill={conditionColors[cond] || '#888'}
              stroke="rgba(0,0,0,0.5)"
              strokeWidth={1}
            />
          ))}
        </Group>
      )}
    </Group>
  );
}

const isWithinVision = (tokenToCheck: Token, myTokens: Token[], gridSize: number) => {
  for (const my of myTokens) {
    const dx = tokenToCheck.x - my.x;
    const dy = tokenToCheck.y - my.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= gridSize * 8) return true; // 8 cells = 40ft vision
  }
  return false;
};

export function TokenLayer() {
  const tokens = useMapStore((s) => s.tokens);
  const selectedTokenId = useMapStore((s) => s.selectedTokenId);
  const combatActive = useCombatStore((s) => s.active);
  const currentTurnIndex = useCombatStore((s) => s.currentTurnIndex);
  const combatants = useCombatStore((s) => s.combatants);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const enableFog = useSessionStore((s) => s.settings.enableFogOfWar);
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);

  const currentTurnTokenId = combatActive
    ? combatants[currentTurnIndex]?.tokenId ?? null
    : null;

  // DM sees all tokens (hidden ones rendered at low opacity).
  // Players only see visible tokens AND can't see invisible enemies.
  const allTokens = Object.values(tokens);
  const visibleTokens = isDM
    ? allTokens
    : allTokens.filter((t) => {
        if (!t.visible) return false;
        // Same-side tokens (your own characters) are always visible to you
        // — Greater Invisibility doesn't hide an ally from yourself.
        if (t.ownerUserId === userId) return true;
        // Opposing-side tokens with the Invisible condition are hidden.
        // Faerie Fire (the "outlined" condition) cancels this in RAW —
        // we let outlined override invisibility.
        const conds = (t.conditions || []) as string[];
        const isInvisible = conds.includes('invisible');
        const isOutlined = conds.includes('outlined');
        if (isInvisible && !isOutlined) return false;
        return true;
      });

  // For non-DM players with fog enabled, filter tokens to only those within vision
  const tokenList = useMemo(() => {
    if (isDM || !enableFog) return visibleTokens;

    const myTokens = visibleTokens.filter((t) => t.ownerUserId === userId);
    return visibleTokens.filter((token) => {
      // Always show own tokens
      if (token.ownerUserId === userId) return true;
      // Show other tokens only if within vision range of any owned token
      return isWithinVision(token, myTokens, gridSize);
    });
  }, [visibleTokens, isDM, enableFog, userId, gridSize]);

  return (
    <Layer>
      {tokenList.map((token) => (
        <TokenSprite
          key={token.id}
          token={token}
          isSelected={token.id === selectedTokenId}
          isCurrentTurn={token.id === currentTurnTokenId}
        />
      ))}
    </Layer>
  );
}
