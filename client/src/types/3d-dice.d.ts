// Minimal declaration for @3d-dice/dice-box — the package ships without
// TypeScript types. We only use the subset of the API covered in
// Dice3DOverlay.tsx, so this surface is intentionally narrow.
declare module '@3d-dice/dice-box' {
  interface DiceBoxOptions {
    /** CSS selector or element. Required since v1.1. */
    container?: string | HTMLElement;
    assetPath: string;
    theme?: string;
    scale?: number;
    gravity?: number;
    mass?: number;
    friction?: number;
    restitution?: number;
    angularDamping?: number;
    linearDamping?: number;
  }

  interface DiceAddSpec {
    qty: number;
    sides: number | `d${number}`;
    value?: number;
    themeColor?: string;
  }

  export default class DiceBox {
    // v1.1+ signature — single options object with `container`.
    constructor(options: DiceBoxOptions);
    init(): Promise<unknown>;
    clear(): void;
    add(spec: DiceAddSpec[] | DiceAddSpec): Promise<unknown>;
    roll(notation: string): Promise<unknown>;
    resize(): void;
    onRollComplete?: (results: unknown) => void;
  }
}
