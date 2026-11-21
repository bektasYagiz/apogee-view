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
  // inferred phases for streams that carry no state
  IDLE: 0x64748b,
  FLIGHT: 0xa3e635,
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
  // lowest vertex index written since the last render uploaded the buffers
  private dirtyFrom = 0;

  constructor() {
    this.geometry.setAttribute("position", this.posAttr);
    this.geometry.setAttribute("color", this.colAttr);
    this.geometry.setDrawRange(0, 0);
    this.object = new Line(this.geometry, new LineBasicMaterial({ vertexColors: true }));
    // bounding sphere is never recomputed as the draw range grows
    this.object.frustumCulled = false;
    // Attribute uploads happen while the render list is built, before this hook, so by now everything is on the GPU.
    this.object.onBeforeRender = () => {
      this.dirtyFrom = this.count;
    };
  }

  /**
   * One range covers everything written since the last render. Many vertices can land between two
   * renders (a replay seek feeds thousands at once), so a per-push range would upload only the last
   * vertex and leave unwritten (0, 0, 0) or stale vertices from earlier passes inside the draw range.
   */
  private markDirty(): void {
    const start = this.dirtyFrom * 3;
    const length = (this.count - this.dirtyFrom) * 3;
    for (const attr of [this.posAttr, this.colAttr]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(start, length);
      attr.needsUpdate = true;
    }
  }

  push(p: Vector3, state: string): void {
    const phase = state.toUpperCase();
    const phaseChanged = phase !== this.lastPhase;
    if (this.count > 0 && !phaseChanged && p.distanceToSquared(this.last) <= MIN_STEP_SQ) return;

    if (this.count === CAPACITY) {
      const half = CAPACITY >> 1;
      this.positions.copyWithin(0, half * 3);
      this.colors.copyWithin(0, half * 3);
      this.count -= half;
      this.dirtyFrom = 0;
    }

    const i = this.count++;
    this.positions.set([p.x, p.y, p.z], i * 3);
    this.tmp.set(PHASE_COLORS[phase] ?? FALLBACK_COLOR);
    this.colors.set([this.tmp.r, this.tmp.g, this.tmp.b], i * 3);
    this.dirtyFrom = Math.min(this.dirtyFrom, i);
    this.markDirty();
    this.geometry.setDrawRange(0, this.count);
    this.last.copy(p);
    this.lastPhase = phase;
  }

  clear(): void {
    this.count = 0;
    this.dirtyFrom = 0;
    this.lastPhase = null;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.object.material as LineBasicMaterial).dispose();
  }
}
