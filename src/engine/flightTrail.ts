import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Line,
  LineBasicMaterial,
  Vector3,
} from "three";

const CAPACITY = 20000;
const MIN_STEP_SQ = 0.05 * 0.05;

const PHASE_COLORS: Record<string, number> = {
  PAD_IDLE: 0x64748b,
  LANDED: 0x64748b,
  BOOST: 0xf97316,
  COAST: 0x06b6d4,
  APOGEE: 0xd946ef,
  DROGUE: 0x10b981,
  MAIN: 0x38bdf8,
};
const FALLBACK_COLOR = 0x14b8a6;

/**
 * Fixed-capacity vertex buffers allocated once; only the draw range grows.
 * When full, the oldest half is shifted out so appends never reallocate.
 */
export class FlightTrail {
  readonly object: Line;
  private readonly positions = new Float32Array(CAPACITY * 3);
  private readonly colors = new Float32Array(CAPACITY * 3);
  private readonly posAttr = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
  private readonly colAttr = new BufferAttribute(this.colors, 3).setUsage(DynamicDrawUsage);
  private readonly geometry = new BufferGeometry();
  private readonly last = new Vector3();
  private readonly tmp = new Color();
  private count = 0;
  private lastPhase: string | null = null;

  constructor() {
    this.geometry.setAttribute("position", this.posAttr);
    this.geometry.setAttribute("color", this.colAttr);
    this.geometry.setDrawRange(0, 0);
    this.object = new Line(this.geometry, new LineBasicMaterial({ vertexColors: true }));
    // bounding sphere is never recomputed as the draw range grows
    this.object.frustumCulled = false;
  }

  push(p: Vector3, state: string): void {
    const phase = state.toUpperCase();
    const phaseChanged = phase !== this.lastPhase;
    if (this.count > 0 && !phaseChanged && p.distanceToSquared(this.last) <= MIN_STEP_SQ) return;

    let fullUpload = false;
    if (this.count === CAPACITY) {
      const half = CAPACITY >> 1;
      this.positions.copyWithin(0, half * 3);
      this.colors.copyWithin(0, half * 3);
      this.count -= half;
      fullUpload = true;
    }

    const i = this.count++;
    this.positions.set([p.x, p.y, p.z], i * 3);
    this.tmp.set(PHASE_COLORS[phase] ?? FALLBACK_COLOR);
    this.colors.set([this.tmp.r, this.tmp.g, this.tmp.b], i * 3);

    for (const attr of [this.posAttr, this.colAttr]) {
      attr.clearUpdateRanges();
      if (!fullUpload) attr.addUpdateRange(i * 3, 3);
      attr.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, this.count);
    this.last.copy(p);
    this.lastPhase = phase;
  }

  clear(): void {
    this.count = 0;
    this.lastPhase = null;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.object.material as LineBasicMaterial).dispose();
  }
}
