import { useEffect, useRef, useState, useMemo } from 'react';
import { Layer, Group, Circle, Rect, Text, Ring, Shape, Line, Arrow } from 'react-konva';
import type { Token, TokenAura } from '@dnd-vtt/shared';
import { useMapStore } from '../../../stores/useMapStore';
import { useCombatStore } from '../../../stores/useCombatStore';
import { useSessionStore } from '../../../stores/useSessionStore';
import { useCharacterStore } from '../../../stores/useCharacterStore';
import { useDrawStore } from '../../../stores/useDrawStore';
import { useDragToken } from '../../../hooks/useDragToken';
import { theme } from '../../../styles/theme';

// Stable empty array to avoid creating new [] on every render
// (causes "getSnapshot should be cached" infinite loop in React)
const EMPTY_STAGED: never[] = [];

// ── Condition visual effects ──────────────────────────────────────────
const CONDITION_VISUALS: Record<string, { color: string; opacity: number; effect: 'tint' | 'glow' | 'pulse' | 'overlay' }> = {
  poisoned:       { color: '#2ecc71', opacity: 0.3,  effect: 'tint' },
  burning:        { color: '#e67e22', opacity: 0.4,  effect: 'glow' },
  frozen:         { color: '#3498db', opacity: 0.3,  effect: 'tint' },
  stunned:        { color: '#f1c40f', opacity: 0.3,  effect: 'pulse' },
  paralyzed:      { color: '#f1c40f', opacity: 0.4,  effect: 'tint' },
  frightened:     { color: '#9b59b6', opacity: 0.3,  effect: 'pulse' },
  invisible:      { color: 'transparent', opacity: 0.3, effect: 'overlay' },
  prone:          { color: '#95a5a6', opacity: 0.2,  effect: 'tint' },
  restrained:     { color: '#e74c3c', opacity: 0.3,  effect: 'tint' },
  charmed:        { color: '#e91e63', opacity: 0.3,  effect: 'glow' },
  blinded:        { color: '#2c3e50', opacity: 0.4,  effect: 'overlay' },
  deafened:       { color: '#7f8c8d', opacity: 0.2,  effect: 'tint' },
  concentration:  { color: '#3498db', opacity: 0.2,  effect: 'glow' },
  blessed:        { color: '#f1c40f', opacity: 0.25, effect: 'glow' },
  hexed:          { color: '#8e44ad', opacity: 0.3,  effect: 'glow' },
};

/**
 * Shared pulse animation hook for condition overlays.
 */
function usePulseOpacity(active: boolean) {
  const [pulseOpacity, setPulseOpacity] = useState(0.2);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!active) return;
    const start = performance.now();
    const animate = (time: number) => {
      const elapsed = (time - start) / 1000;
      const t = (Math.sin(elapsed * 2.5) + 1) / 2;
      setPulseOpacity(0.15 + t * 0.35);
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active]);

  return pulseOpacity;
}

/**
 * Renders glow/pulse condition effects BEHIND the token.
 */
function ConditionGlowLayer({ conditions, tokenSize }: { conditions: string[]; tokenSize: number }) {
  const hasPulse = conditions.some((c) => CONDITION_VISUALS[c]?.effect === 'pulse');
  const pulseOpacity = usePulseOpacity(hasPulse);

  const elements: React.ReactNode[] = [];
  for (const cond of conditions) {
    const vis = CONDITION_VISUALS[cond];
    if (!vis) continue;
    if (vis.effect === 'glow' || vis.effect === 'pulse') {
      const glowRadius = tokenSize / 2 + 10;
      const op = vis.effect === 'pulse' ? pulseOpacity : vis.opacity;
      elements.push(
        <Circle
          key={`glow-${cond}`}
          radius={glowRadius}
          fillRadialGradientStartPoint={{ x: 0, y: 0 }}
          fillRadialGradientStartRadius={0}
          fillRadialGradientEndPoint={{ x: 0, y: 0 }}
          fillRadialGradientEndRadius={glowRadius}
          fillRadialGradientColorStops={[0, vis.color, 0.6, vis.color, 1, 'transparent']}
          opacity={op}
          listening={false}
        />
      );
    }
  }
  if (elements.length === 0) return null;
  return <>{elements}</>;
}

/**
 * Renders tint/overlay condition effects ON TOP of the token.
 */
function ConditionTintLayer({ conditions, tokenSize }: { conditions: string[]; tokenSize: number }) {
  const elements: React.ReactNode[] = [];
  for (const cond of conditions) {
    const vis = CONDITION_VISUALS[cond];
    if (!vis) continue;
    if (vis.effect === 'tint') {
      elements.push(
        <Circle
          key={`tint-${cond}`}
          radius={tokenSize / 2}
          fill={vis.color}
          opacity={vis.opacity}
          listening={false}
        />
      );
    }
    // 'overlay' with a non-transparent color (e.g. blinded) renders
    // as a dark tint on top; 'invisible' is transparent and handled
    // by groupOpacity in TokenSprite instead.
    if (vis.effect === 'overlay' && vis.color !== 'transparent') {
      elements.push(
        <Circle
          key={`overlay-${cond}`}
          radius={tokenSize / 2}
          fill={vis.color}
          opacity={vis.opacity}
          listening={false}
        />
      );
    }
  }
  if (elements.length === 0) return null;
  return <>{elements}</>;
}

// ── Aura overlay ──────────────────────────────────────────────────────
function AuraOverlay({ aura, gridSize }: { aura: TokenAura; gridSize: number }) {
  const radiusPx = (aura.radiusFeet / 5) * gridSize;

  if (aura.shape === 'square') {
    const side = radiusPx * 2;
    return (
      <Rect
        x={-side / 2}
        y={-side / 2}
        width={side}
        height={side}
        fill={aura.color}
        opacity={aura.opacity}
        cornerRadius={4}
        listening={false}
      />
    );
  }

  // Circle with soft edge via radial gradient
  return (
    <Circle
      radius={radiusPx}
      fillRadialGradientStartPoint={{ x: 0, y: 0 }}
      fillRadialGradientStartRadius={0}
      fillRadialGradientEndPoint={{ x: 0, y: 0 }}
      fillRadialGradientEndRadius={radiusPx}
      fillRadialGradientColorStops={[0, aura.color, 0.7, aura.color, 1, 'transparent']}
      opacity={aura.opacity}
      listening={false}
    />
  );
}

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
  showTokenLabels: boolean;
}

function TokenSprite({ token, isSelected, isCurrentTurn, showTokenLabels }: TokenSpriteProps) {
  const { draggable, onDragStart, onDragEnd, onDragMove } = useDragToken(token.id);
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

  // Action economy for the current-turn token only — drives the
  // movement pill rendered above the HP bar so the player can see
  // their feet remaining without opening the Combat sidebar tab.
  const actionEconomy = useCombatStore((s) => s.actionEconomy);
  const showMovement = isCurrentTurn && actionEconomy && actionEconomy.movementMax > 0;
  const moveRemaining = actionEconomy?.movementRemaining ?? 0;
  const moveMax = actionEconomy?.movementMax ?? 0;
  const moveUsed = Math.max(0, moveMax - moveRemaining);
  const movePctRemaining = moveMax > 0 ? Math.max(0, moveRemaining / moveMax) : 0;
  const moveColor =
    movePctRemaining > 0.5 ? '#5ba3d5'   // bright blue
    : movePctRemaining > 0.1 ? '#d4a843' // gold (running low)
    : '#c53131';                          // red (out of move)
  // HP ratio: prefer combatant (combat), then character store, then 1 (full)
  const currentHp = combatant ? combatant.hp : charHp;
  const currentMaxHp = combatant ? combatant.maxHp : charMaxHp;
  const actualHpRatio = combatant
    ? Math.max(0, combatant.hp / Math.max(1, combatant.maxHp))
    : (charHp !== null && charMaxHp !== null && charMaxHp > 0)
      ? Math.max(0, charHp / charMaxHp)
      : 1;
  const hasHpData = currentHp !== null && currentMaxHp !== null && currentMaxHp > 0;

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
  const userId = useSessionStore.getState().userId;
  const isNPC = !token.ownerUserId;

  // HP bar visibility: DM sees all, players see own + visible creature bars
  const isOwnToken = token.ownerUserId === userId;
  const showHpBarForPlayer = isDM || isOwnToken || (isNPC && token.visible);
  const showHpBar = showHpBarForPlayer && hasHpData && (combatant || (charHp !== null && charMaxHp !== null && charHp < charMaxHp));

  // Loot bag tokens (race === 'loot' or item image) should never show as dead
  const isLootBag = charData?.race === 'loot' || (token.imageUrl?.includes('/uploads/items/'));
  // Death state — skip for loot bags which naturally have 0 HP
  const isDead = !isLootBag && ((charHp !== null && charHp <= 0) || (combatant && combatant.hp <= 0));

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
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragMove={onDragMove}
      onClick={(e) => {
        // Draw mode swallows all token clicks — every pointer event
        // should feed the drawing pipeline instead of selecting.
        if (useDrawStore.getState().isDrawMode) return;
        const state = useMapStore.getState();
        if (state.isTargeting) {
          window.dispatchEvent(new CustomEvent('target-token-selected', {
            detail: { tokenId: token.id }
          }));
          return;
        }
        // Shift-click (and Meta/Ctrl on Mac) → additive select, so the
        // DM can build a group-action selection without a marquee drag.
        const evt = e?.evt as MouseEvent | undefined;
        const additive = !!evt && (evt.shiftKey || evt.metaKey || evt.ctrlKey);
        selectToken(token.id, additive);
      }}
      onTap={() => {
        if (useDrawStore.getState().isDrawMode) return;
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
        // Draw mode: suppress the token context menu. The DM can Esc
        // out of draw mode first if they need to right-click a token.
        if (useDrawStore.getState().isDrawMode) {
          e.evt.preventDefault();
          e.evt.stopPropagation();
          return;
        }
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
      // Long-press on mobile opens the same context menu as right-click
      // on desktop. Konva's `onTouchStart` + `onTouchEnd` feed us the
      // raw TouchEvent; we schedule a timer on start and cancel it on
      // move / end unless it fired. 500ms matches iOS system long-press.
      onTouchStart={(e) => {
        if (useDrawStore.getState().isDrawMode) return;
        const stage = e.target.getStage();
        const node = e.target as unknown as { __longPressTimer?: ReturnType<typeof setTimeout> };
        const startPointer = stage?.getPointerPosition();
        if (!stage || !startPointer) return;
        const container = stage.container().getBoundingClientRect();
        node.__longPressTimer = setTimeout(() => {
          // If the finger has moved more than ~10px, skip — that's a
          // scroll/drag, not a long-press.
          const now = stage.getPointerPosition();
          if (!now) return;
          if (Math.hypot(now.x - startPointer.x, now.y - startPointer.y) > 10) return;
          useMapStore.getState().setContextMenu(token.id, {
            x: now.x + container.left,
            y: now.y + container.top,
          });
        }, 500);
      }}
      onTouchMove={(e) => {
        const node = e.target as unknown as { __longPressTimer?: ReturnType<typeof setTimeout> };
        if (node.__longPressTimer) { clearTimeout(node.__longPressTimer); node.__longPressTimer = undefined; }
      }}
      onTouchEnd={(e) => {
        const node = e.target as unknown as { __longPressTimer?: ReturnType<typeof setTimeout> };
        if (node.__longPressTimer) { clearTimeout(node.__longPressTimer); node.__longPressTimer = undefined; }
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
      {/* Aura overlay — renders behind everything */}
      {token.aura && (
        <AuraOverlay aura={token.aura} gridSize={gridSize} />
      )}

      {/* Condition glow/pulse effects — behind the token */}
      {tokenConditions.length > 0 && (
        <ConditionGlowLayer conditions={tokenConditions} tokenSize={tokenSize} />
      )}

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

      {/* Condition tint/overlay effects — on top of the token */}
      {tokenConditions.length > 0 && (
        <ConditionTintLayer conditions={tokenConditions} tokenSize={tokenSize} />
      )}

      {/* Skull overlay for dead tokens */}
      {isDead && (
        <Group>
          <TokenImage url={`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#333" opacity="0.85"/><text x="32" y="44" text-anchor="middle" font-size="36" fill="#ccc" font-family="sans-serif">&#x1F480;</text></svg>')}`} size={tokenSize * 0.7} />
        </Group>
      )}

      {/* HP bar (below token) - shows during combat OR when damaged */}
      {showHpBar && (
        <Group y={tokenSize / 2 + 1}>
          {/* Background bar */}
          <Rect
            x={-tokenSize / 2}
            y={0}
            width={tokenSize}
            height={4}
            fill="rgba(40,40,40,0.85)"
            cornerRadius={2}
          />
          {/* Fill bar */}
          <Rect
            x={-tokenSize / 2}
            y={0}
            width={Math.max(0, tokenSize * actualHpRatio)}
            height={4}
            fill={hpColor}
            cornerRadius={2}
          />
          {/* HP text - only show if token is large enough (size >= 1) */}
          {token.size >= 1 && currentHp !== null && currentMaxHp !== null && (
            <Text
              x={-tokenSize / 2}
              y={-1}
              width={tokenSize}
              height={6}
              align="center"
              text={`${currentHp}/${currentMaxHp}`}
              fontSize={8}
              fontFamily="monospace"
              fontStyle="bold"
              fill="#fff"
              shadowColor="black"
              shadowBlur={2}
              shadowEnabled
            />
          )}
        </Group>
      )}

      {/* Movement pill (above HP bar) — only shown for the current
          combatant. Mirrors the HP bar layout: a thin progress bar
          with a numeric label sitting on top so players can see how
          many feet they've moved and how many remain at a glance,
          without needing the Combat sidebar tab open. */}
      {showMovement && (() => {
        const labelText = `${moveRemaining} / ${moveMax} ft`;
        const labelW = Math.max(tokenSize + 4, 56);
        const yBase = -tokenSize / 2 - 24;
        return (
          <Group y={yBase}>
            {/* Background pill */}
            <Rect
              x={-labelW / 2}
              y={0}
              width={labelW}
              height={13}
              fill="rgba(10,10,18,0.85)"
              stroke={moveColor}
              strokeWidth={1}
              cornerRadius={6}
              shadowColor="rgba(0,0,0,0.5)"
              shadowBlur={3}
              shadowOffset={{ x: 0, y: 1 }}
              shadowEnabled
            />
            {/* Inner progress fill — left side is "used", right side is "remaining" */}
            <Rect
              x={-labelW / 2 + 2}
              y={2}
              width={Math.max(0, (labelW - 4) * movePctRemaining)}
              height={9}
              fill={moveColor}
              opacity={0.25}
              cornerRadius={4}
            />
            {/* Numeric label */}
            <Text
              x={-labelW / 2}
              y={1}
              width={labelW}
              align="center"
              text={labelText}
              fontSize={9}
              fontStyle="bold"
              fill={moveColor}
              shadowColor="black"
              shadowBlur={2}
              shadowEnabled
            />
            {/* Used distance ticker on the side, only when something has moved */}
            {moveUsed > 0 && (
              <Text
                x={labelW / 2 + 4}
                y={1}
                text={`-${moveUsed}`}
                fontSize={8}
                fontStyle="bold"
                fill="#888"
              />
            )}
          </Group>
        );
      })()}

      {/* Name label background + text (below token + HP bar).
          Shown always when showTokenLabels is on, or when the token
          is selected / hovered (name is also in the tooltip). The
          background is tinted by the token's faction so the combat
          side is obvious at a glance. */}
      {(showTokenLabels || isSelected) && (() => {
        const hpBarOffset = showHpBar ? 7 : 0;
        const labelWidth = Math.max(tokenSize + 20, Math.min(token.name.length * 6.5 + 16, 160));
        const needsWrap = token.name.length > (tokenSize + 20) / 6;
        const labelHeight = needsWrap ? 26 : 16;
        const faction = (token as { faction?: string }).faction ?? 'neutral';
        // Semi-transparent tint over a dark base so the name stays legible.
        const labelFill =
          faction === 'friendly' ? 'rgba(46,204,113,0.75)' :
          faction === 'hostile'  ? 'rgba(231,76,60,0.75)'  :
                                   'rgba(0,0,0,0.75)';
        const labelStroke =
          faction === 'friendly' ? '#2ecc71' :
          faction === 'hostile'  ? '#e74c3c' :
                                   'transparent';
        return (
          <>
            <Rect
              x={-labelWidth / 2}
              y={tokenSize / 2 + 2 + hpBarOffset}
              width={labelWidth}
              height={labelHeight}
              fill={labelFill}
              stroke={labelStroke}
              strokeWidth={labelStroke === 'transparent' ? 0 : 1}
              cornerRadius={4}
            />
            <Text
              text={token.name}
              y={tokenSize / 2 + 3 + hpBarOffset}
              x={-labelWidth / 2}
              width={labelWidth}
              align="center"
              fontSize={10}
              fontStyle="bold"
              fill="#fff"
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
      {isDead && (() => {
        const hpBarOffset = showHpBar ? 7 : 0;
        const labelVisible = showTokenLabels || isSelected;
        const nameLabelOffset = labelVisible ? (token.name.length > (tokenSize + 20) / 6 ? 28 : 18) : 2;
        return (
          <Text
            text="DEAD"
            y={tokenSize / 2 + nameLabelOffset + hpBarOffset}
            x={-30}
            width={60}
            align="center"
            fontSize={9}
            fontStyle="bold"
            fill="#c53131"
          />
        );
      })()}

      {/* Condition badges */}
      {token.conditions.length > 0 && (
        <Group y={tokenSize / 2 + ((showTokenLabels || isSelected) ? 20 : 6) + (showHpBar ? 7 : 0)}>
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

/**
 * Movement preview overlay — only renders while a token is being
 * actively dragged. Draws three things:
 *
 *   1. A faded "ghost" of the token at its ORIGINAL position so you
 *      remember where you started from.
 *   2. A blue dashed arrow from the ghost to the cursor position.
 *   3. A pill label near the arrow tip showing how many feet the
 *      drag covers (5e Chebyshev distance — diagonal squares = 5 ft).
 *
 * The arrow color shifts green → gold → red as the drag distance
 * approaches the current combatant's remaining movement, so you can
 * tell at a glance whether the move would exceed your speed.
 */
function MovementPreview() {
  const dragPreview = useMapStore((s) => s.dragPreview);
  const tokens = useMapStore((s) => s.tokens);
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);
  const combat = useCombatStore((s) => s.actionEconomy);
  const isCombatActive = useCombatStore((s) => s.active);
  const currentTurnTokenId = useCombatStore((s) =>
    s.combatants[s.currentTurnIndex]?.tokenId ?? null,
  );

  if (!dragPreview) return null;
  const token = tokens[dragPreview.tokenId];
  if (!token) return null;

  const tokenSize = gridSize * (token.size || 1);
  const halfSize = tokenSize / 2;

  // In TokenSprite the token Group is positioned at (token.x, token.y)
  // and its image / circle children render around the Group's (0,0)
  // origin — so token.x/y IS the visual center of the portrait, NOT
  // the top-left. Use the drag positions directly as the arrow
  // endpoints so the line emerges from the middle of the portrait.
  const startCx = dragPreview.startX;
  const startCy = dragPreview.startY;
  const curCx = dragPreview.currentX;
  const curCy = dragPreview.currentY;

  // Distance in feet — Chebyshev with diagonals = 5 ft (5e variant).
  const dxPx = dragPreview.currentX - dragPreview.startX;
  const dyPx = dragPreview.currentY - dragPreview.startY;
  const cellsX = Math.round(Math.abs(dxPx) / gridSize);
  const cellsY = Math.round(Math.abs(dyPx) / gridSize);
  const cells = Math.max(cellsX, cellsY);
  const feet = cells * 5;

  // Color the arrow + label by how much movement remains. Only
  // applies when this token is the active combatant in combat — DM
  // teleports of off-turn tokens always render in neutral blue.
  const isActiveCombatant = isCombatActive && currentTurnTokenId === dragPreview.tokenId;
  let lineColor = '#5ba3d5'; // neutral blue
  let labelText = `${feet} ft`;
  if (isActiveCombatant && combat.movementMax > 0) {
    const remaining = combat.movementRemaining;
    const max = combat.movementMax;
    if (feet > remaining) {
      lineColor = '#c53131'; // red — over budget
      labelText = `${feet} ft  •  exceeds ${remaining}/${max} ft remaining`;
    } else if (feet > remaining * 0.66) {
      lineColor = '#d4a843'; // gold — close to the limit
      labelText = `${feet} / ${remaining} ft remaining`;
    } else {
      lineColor = '#5ba3d5'; // blue — comfortable
      labelText = `${feet} / ${remaining} ft remaining`;
    }
  }

  // Tip of the arrow points at the cursor center, but pull it back
  // by half the token's radius so the arrowhead doesn't sit inside
  // the moving token sprite.
  const dist = Math.hypot(curCx - startCx, curCy - startCy);
  const pullback = Math.min(halfSize * 0.6, dist * 0.4);
  const arrowEndX = dist > 0 ? curCx - ((curCx - startCx) / dist) * pullback : curCx;
  const arrowEndY = dist > 0 ? curCy - ((curCy - startCy) / dist) * pullback : curCy;

  // Skip rendering when nothing has moved yet — avoids a stale label
  // showing "0 ft" right when the drag begins.
  const hasMoved = dist > 1;

  return (
    <Group listening={false}>
      {/* Faded ghost at the original position. Group origin = token
          visual center, so children render at (0,0) — matches how
          TokenSprite positions its Circle / TokenImage children. */}
      <Group x={dragPreview.startX} y={dragPreview.startY} opacity={0.32}>
        {token.imageUrl ? (
          <TokenImage url={token.imageUrl} size={tokenSize} />
        ) : (
          <Circle radius={halfSize} fill={token.color || '#666'} />
        )}
        <Circle
          radius={halfSize}
          stroke="#5ba3d5"
          strokeWidth={2}
          dash={[6, 4]}
          fill="transparent"
        />
      </Group>

      {/* Distance arrow from ghost center to cursor center */}
      {hasMoved && (
        <>
          <Arrow
            points={[startCx, startCy, arrowEndX, arrowEndY]}
            stroke={lineColor}
            strokeWidth={3}
            fill={lineColor}
            pointerLength={10}
            pointerWidth={10}
            dash={[10, 6]}
            shadowColor={lineColor}
            shadowBlur={8}
            shadowOpacity={0.5}
            opacity={0.9}
          />

          {/* Distance pill — sits at the midpoint of the arrow */}
          {(() => {
            const midX = (startCx + arrowEndX) / 2;
            const midY = (startCy + arrowEndY) / 2;
            const labelW = Math.max(60, labelText.length * 6 + 18);
            const labelH = 20;
            // Offset slightly perpendicular so it doesn't sit ON the line
            const perpX = dist > 0 ? -(arrowEndY - startCy) / dist : 0;
            const perpY = dist > 0 ? (arrowEndX - startCx) / dist : -1;
            const off = 18;
            const lx = midX + perpX * off - labelW / 2;
            const ly = midY + perpY * off - labelH / 2;
            return (
              <Group x={lx} y={ly}>
                <Rect
                  width={labelW}
                  height={labelH}
                  fill="rgba(10,10,18,0.92)"
                  stroke={lineColor}
                  strokeWidth={1.5}
                  cornerRadius={10}
                  shadowColor="rgba(0,0,0,0.5)"
                  shadowBlur={4}
                  shadowOpacity={1}
                />
                <Text
                  x={0}
                  y={4}
                  width={labelW}
                  align="center"
                  text={labelText}
                  fontSize={11}
                  fontStyle="bold"
                  fill={lineColor}
                />
              </Group>
            );
          })()}
        </>
      )}
    </Group>
  );
}

/**
 * Ghost token rendered for each staged hero during DM map preview.
 * Semi-transparent with a gold dashed border to distinguish from real tokens.
 * Draggable so the DM can reposition heroes before activating the map.
 */
function StagedHeroGhost({
  hero,
  gridSize,
}: {
  hero: { characterId: string; name: string; portraitUrl: string | null; x: number; y: number };
  gridSize: number;
}) {
  const tokenSize = gridSize; // size = 1

  // Snap helper: round to nearest grid center
  const snapToGrid = (val: number) =>
    Math.round((val - gridSize / 2) / gridSize) * gridSize + gridSize / 2;

  const labelWidth = Math.max(tokenSize + 20, Math.min(hero.name.length * 6.5 + 16, 160));

  return (
    <Group
      x={hero.x}
      y={hero.y}
      opacity={0.5}
      draggable
      onDragEnd={(e) => {
        const node = e.target;
        const newX = snapToGrid(node.x());
        const newY = snapToGrid(node.y());
        node.x(newX);
        node.y(newY);
        const mapId = useMapStore.getState().currentMap?.id;
        if (mapId) useMapStore.getState().moveStagedHero(mapId, hero.characterId, newX, newY);
      }}
    >
      {/* Hit area — invisible but hittable so the Group drag works */}
      <Circle
        radius={tokenSize / 2 + 6}
        fill="rgba(0,0,0,0.01)"
      />
      {/* Gold dashed border */}
      <Circle
        radius={tokenSize / 2 + 3}
        stroke={theme.gold.primary}
        strokeWidth={2}
        dash={[8, 4]}
        listening={false}
      />
      {/* Portrait */}
      {hero.portraitUrl ? (
        <TokenImage url={hero.portraitUrl} size={tokenSize} />
      ) : (
        <Circle radius={tokenSize / 2} fill="#555" />
      )}
      {/* Name label below */}
      <Rect
        x={-labelWidth / 2}
        y={tokenSize / 2 + 2}
        width={labelWidth}
        height={16}
        fill="rgba(0,0,0,0.75)"
        cornerRadius={4}
      />
      <Text
        text={hero.name}
        y={tokenSize / 2 + 3}
        x={-labelWidth / 2}
        width={labelWidth}
        align="center"
        fontSize={10}
        fontStyle="bold"
        fill={theme.gold.primary}
        shadowColor="black"
        shadowBlur={3}
        shadowOffset={{ x: 0, y: 1 }}
        shadowEnabled
      />
    </Group>
  );
}

export function TokenLayer() {
  const tokens = useMapStore((s) => s.tokens);
  const selectedTokenId = useMapStore((s) => s.selectedTokenId);
  const selectedTokenIds = useMapStore((s) => s.selectedTokenIds);
  const combatActive = useCombatStore((s) => s.active);
  const currentTurnIndex = useCombatStore((s) => s.currentTurnIndex);
  const combatants = useCombatStore((s) => s.combatants);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const enableFog = useSessionStore((s) => s.settings.enableFogOfWar);
  const showTokenLabels = useSessionStore((s) => s.settings.showTokenLabels ?? false);
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);
  const currentMapId = useMapStore((s) => s.currentMap?.id ?? null);
  const stagedHeroesMap = useMapStore((s) => s.stagedHeroes);
  const stagedHeroes = (currentMapId && stagedHeroesMap[currentMapId]) || EMPTY_STAGED;

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
          isSelected={token.id === selectedTokenId || selectedTokenIds.includes(token.id)}
          isCurrentTurn={token.id === currentTurnTokenId}
          showTokenLabels={showTokenLabels}
        />
      ))}
      {/* Drag preview overlay (ghost + blue arrow + distance label).
          Mounts only while a drag is in progress; renders after the
          token sprites so it draws on top. */}
      <MovementPreview />
      {/* Staged hero ghosts — DM-only, shown during map preview before activation */}
      {isDM &&
        stagedHeroes.map((hero) => (
          <StagedHeroGhost key={hero.characterId} hero={hero} gridSize={gridSize} />
        ))}
    </Layer>
  );
}
