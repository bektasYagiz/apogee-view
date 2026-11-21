import { metersPerDegree } from "../engine/coordinates";
import type { TelemetryFrame } from "../engine/types";

export const PHASE_CSS: Record<string, string> = {
  PAD_IDLE: "#64748b",
  LANDED: "#64748b",
  BOOST: "#f97316",
  COAST: "#06b6d4",
  APOGEE: "#d946ef",
  DROGUE: "#10b981",
  MAIN: "#38bdf8",
  IDLE: "#64748b",
  FLIGHT: "#a3e635",
};
export const PHASE_FALLBACK_CSS = "#14b8a6";

const RAD = 180 / Math.PI;
const RATE_WINDOW_MS = 1000;
const SMOOTH = 0.35;

// Binary packets carry no state byte, so phase is inferred from kinematics when state is UNKNOWN.
const GROUND_AGL = 2.0;
const LIFTOFF_VSPEED = 1.5;
const LANDED_VSPEED = 0.5;
const LANDED_HOLD_MS = 1000;
type InferredPhase = "IDLE" | "FLIGHT";
// frame `ts` is the flight computer's millisecond counter
const TS_PER_SECOND = 1000;

export type LinkStatus = "LIVE" | "REPLAY" | "WAITING" | "NO SIGNAL";

export interface StatsSnapshot {
  state: string;
  originAlt: number | null;
  agl: number;
  apogee: number;
  speed: number;
  vSpeed: number;
  rateHz: number;
  roll: number;
  pitch: number;
  yaw: number;
  lat: number;
  lon: number;
  hasFrame: boolean;
}

export function eulerFromNedQuat([w, x, y, z]: readonly [number, number, number, number]) {
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { roll: roll * RAD, pitch: pitch * RAD, yaw: (yaw * RAD + 360) % 360 };
}

export class TelemetryStats {
  private originAlt: number | null = null;
  private apogee = 0;
  private speed = 0;
  private vSpeed = 0;
  private prev: TelemetryFrame | null = null;
  private last: TelemetryFrame | null = null;
  private arrivals: number[] = [];

  private phase: InferredPhase = "IDLE";
  private settledSince: number | null = null;

  /**
   * Call once per frame, in order; `now` is wall-clock ms used for the packet rate only.
   * Returns the frame with an inferred phase swapped in when the sender gave none (state UNKNOWN).
   */
  update(frame: TelemetryFrame, now: number): TelemetryFrame {
    this.originAlt ??= frame.alt;
    const agl = frame.alt - this.originAlt;
    if (agl > this.apogee) this.apogee = agl;

    const p = this.prev;
    const dt = p ? (frame.ts - p.ts) / TS_PER_SECOND : 0;
    if (p && dt > 0) {
      const m = metersPerDegree(frame.lat);
      const dN = (frame.lat - p.lat) * m.lat;
      const dE = (frame.lon - p.lon) * m.lon;
      const dU = frame.alt - p.alt;
      this.speed += SMOOTH * (Math.hypot(dN, dE, dU) / dt - this.speed);
      this.vSpeed += SMOOTH * (dU / dt - this.vSpeed);
    }
    this.advancePhase(frame.ts, agl);
    const resolved = frame.state === "UNKNOWN" ? { ...frame, state: this.phase } : frame;
    this.prev = frame;
    this.last = resolved;

    this.arrivals.push(now);
    while (this.arrivals.length && now - this.arrivals[0] > RATE_WINDOW_MS) this.arrivals.shift();
    return resolved;
  }

  private advancePhase(ts: number, agl: number): void {
    const v = Math.abs(this.vSpeed);
    if (this.phase === "IDLE") {
      if (agl > GROUND_AGL || v >= LIFTOFF_VSPEED) this.phase = "FLIGHT";
      return;
    }
    if (agl >= GROUND_AGL || v >= LANDED_VSPEED) {
      this.settledSince = null;
      return;
    }
    this.settledSince ??= ts;
    if (ts - this.settledSince >= LANDED_HOLD_MS) {
      this.phase = "IDLE";
      this.settledSince = null;
    }
  }

  reset(): void {
    this.phase = "IDLE";
    this.settledSince = null;
    this.originAlt = null;
    this.apogee = 0;
    this.speed = 0;
    this.vSpeed = 0;
    this.prev = null;
    this.last = null;
    this.arrivals = [];
  }

  snapshot(now: number): StatsSnapshot {
    const f = this.last;
    const live = this.arrivals.filter((t) => now - t <= RATE_WINDOW_MS);
    const euler = f ? eulerFromNedQuat(f.quat) : { roll: 0, pitch: 0, yaw: 0 };
    return {
      state: f?.state ?? "UNKNOWN",
      originAlt: this.originAlt,
      agl: f && this.originAlt !== null ? f.alt - this.originAlt : 0,
      apogee: this.apogee,
      speed: this.speed,
      vSpeed: this.vSpeed,
      rateHz: live.length,
      ...euler,
      lat: f?.lat ?? 0,
      lon: f?.lon ?? 0,
      hasFrame: f !== null,
    };
  }
}
