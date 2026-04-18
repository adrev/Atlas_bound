import {
  Book,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Footprints,
  Hand,
  Heart,
  Map as MapIcon,
  MessageSquare,
  Moon,
  Music,
  Plus,
  ScrollText,
  Search,
  Send,
  Settings,
  Shield,
  Sun,
  Swords,
  Upload,
  User,
  Users,
  X,
  Zap,
  type LucideProps,
} from 'lucide-react';
import type { FC, SVGProps } from 'react';

/**
 * KBRT icon name → component map.
 *
 * The design handoff (`design-handoff/project/src/icons.jsx`) defines ~40 SVG
 * icons referenced by name. We map each name to a lucide-react equivalent.
 * Custom dice polygons + crest marks live as inline SVGs below because
 * lucide only has Dice1-6 and nothing resembling a d20 crest.
 */
const LUCIDE_ICONS: Record<string, FC<LucideProps>> = {
  book: BookOpen,
  tome: Book,
  scroll: ScrollText,
  chat: MessageSquare,
  users: Users,
  user: User,
  gear: Settings,
  map: MapIcon,
  swords: Swords,
  heart: Heart,
  shield: Shield,
  bolt: Zap,
  moon: Moon,
  sun: Sun,
  footprints: Footprints,
  hand: Hand,
  hide: EyeOff,
  eye: Eye,
  music: Music,
  search: Search,
  plus: Plus,
  send: Send,
  upload: Upload,
  copy: Copy,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  x: X,
};

type CustomSvgProps = { size: number } & SVGProps<SVGSVGElement>;

function makeDie(sides: number): FC<CustomSvgProps> {
  // Simple regular polygons that read as "a die" without pretending to be
  // real 3D dice. The dice label sits on top via .die-btn span.
  return ({ size, ...rest }) => {
    const cx = 50;
    const cy = 50;
    const r = 44;
    const n = sides === 100 ? 10 : Math.min(sides, 12);
    const points: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      points.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
    }
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" fill="none" {...rest}>
        <polygon
          points={points.join(' ')}
          stroke="currentColor"
          strokeWidth="3"
          strokeLinejoin="round"
        />
      </svg>
    );
  };
}

const D4 = makeDie(4);
const D6 = makeDie(4); // square rotated
const D8 = makeDie(8);
const D10 = makeDie(10);
const D12 = makeDie(12);
const D20 = makeDie(12); // close enough; we render a dodecagon backdrop for d20
const D100 = makeDie(10);

const DIE_ICONS: Record<string, FC<CustomSvgProps>> = {
  d4: D4,
  d6: D6,
  d8: D8,
  d10: D10,
  d12: D12,
  d20: D20,
  d100: D100,
};

/** d20 crest (Login page hero mark). Big ornate d20 inside a circle. */
export const D20Crest: FC<CustomSvgProps> = ({ size, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 200 200" fill="none" {...rest}>
    <circle cx="100" cy="100" r="94" stroke="currentColor" strokeWidth="3" opacity="0.4" />
    <circle cx="100" cy="100" r="82" stroke="currentColor" strokeWidth="1" opacity="0.25" />
    {/* Ornamental ticks */}
    {Array.from({ length: 20 }).map((_, i) => {
      const a = (Math.PI * 2 * i) / 20 - Math.PI / 2;
      const r1 = 70;
      const r2 = 78;
      return (
        <line
          key={i}
          x1={100 + r1 * Math.cos(a)}
          y1={100 + r1 * Math.sin(a)}
          x2={100 + r2 * Math.cos(a)}
          y2={100 + r2 * Math.sin(a)}
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.55"
        />
      );
    })}
    {/* d20 icosahedron outline */}
    <polygon
      points="100,30 145,65 145,120 100,150 55,120 55,65"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinejoin="round"
    />
    <polygon
      points="100,30 145,65 100,90 55,65"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      opacity="0.55"
    />
    <polygon
      points="100,90 145,65 145,120 100,150 55,120 55,65"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      opacity="0.55"
    />
    <text
      x="100"
      y="118"
      textAnchor="middle"
      fontFamily="var(--font-display)"
      fontSize="42"
      fontWeight="800"
      fill="currentColor"
    >
      20
    </text>
  </svg>
);

/** Corner filigree (map chrome). Re-rotated via CSS .corner.tl/tr/bl/br. */
export const CornerFiligree: FC<CustomSvgProps> = ({ size, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.1" {...rest}>
    <path d="M0 8 Q6 8 10 14 Q14 20 14 28 Q14 34 10 38 Q6 42 0 42" />
    <path d="M8 0 Q8 6 14 10 Q20 14 28 14 Q34 14 38 10 Q42 6 42 0" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M18 18 Q24 24 30 24 Q36 24 36 18" />
    <path d="M18 18 Q24 24 24 30 Q24 36 18 36" />
    <path d="M4 4 Q10 10 18 18" />
  </svg>
);

/** Ornate flourish divider used between sections. */
export const Flourish: FC<CustomSvgProps> = ({ size, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...rest}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth="1.5" fill="none" />
  </svg>
);

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Named-icon wrapper. Falls back to a neutral placeholder square if the
 * name isn't mapped, so a typo never blows up the UI.
 */
export function Icon({ name, size = 16, className, style }: IconProps): JSX.Element {
  const lucide = LUCIDE_ICONS[name];
  if (lucide) {
    return <>{/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {((): JSX.Element => {
        const Component = lucide;
        return <Component size={size} className={className} style={style} aria-hidden />;
      })()}</>;
  }
  const die = DIE_ICONS[name];
  if (die) {
    const Component = die;
    return <Component size={size} className={className} style={style} aria-hidden />;
  }
  if (name === 'crest' || name === 'd20-crest') {
    return <D20Crest size={size} className={className} style={style} aria-hidden />;
  }
  if (name === 'filigree' || name === 'corner') {
    return <CornerFiligree size={size} className={className} style={style} aria-hidden />;
  }
  if (name === 'flourish') {
    return <Flourish size={size} className={className} style={style} aria-hidden />;
  }
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: '1px dashed currentColor',
        opacity: 0.3,
        ...style,
      }}
    />
  );
}
