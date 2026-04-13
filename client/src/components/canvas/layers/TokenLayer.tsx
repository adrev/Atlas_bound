import { useEffect, useRef, useState, useMemo } from 'react';
import { Layer, Group, Circle, Rect, Text, Ring, Shape, Line, Arrow } from 'react-konva';
import type { Token } from '@dnd-vtt/shared';
import { useMapStore } from '../../../stores/useMapStore';
import { useCombatStore } from '../../../stores/useCombatStore';
import { useSessionStore } from '../../../stores/useSessionStore';
import { useCharacterStore } from '../../../stores/useCharacterStore';
import { useDrawStore } from '../../../stores/useDrawStore';
import { useDragToken } from '../../../hooks/useDragToken';
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
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragMove={onDragMove}
      onClick={() => {
        // Draw mode swallows all token clicks — every pointer event
        // should feed the drawing pipeline instead of selecting.
        if (useDrawStore.getState().isDrawMode) return;
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
  const combatActive = useCombatStore((s) => s.active);
  const currentTurnIndex = useCombatStore((s) => s.currentTurnIndex);
  const combatants = useCombatStore((s) => s.combatants);
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const enableFog = useSessionStore((s) => s.settings.enableFogOfWar);
  const gridSize = useMapStore((s) => s.currentMap?.gridSize ?? 70);
  const currentMapId = useMapStore((s) => s.currentMap?.id ?? null);
  const stagedHeroes = useMapStore((s) =>
    currentMapId ? s.stagedHeroes[currentMapId] ?? [] : [],
  );

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
