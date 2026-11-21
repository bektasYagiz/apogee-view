import { describe, expect, it } from "vitest";
import { metersPerDegree } from "../engine/coordinates";
import type { TelemetryFrame } from "../engine/types";
import { eulerFromNedQuat, TelemetryStats } from "./telemetryStats";

const SMOOTH = 0.35;

// Same ZYX intrinsic formula as euler_to_quat in src-tauri/src/protocol.rs, in degrees, [w, x, y, z].
function eulerToNedQuat(roll: number, pitch: number, yaw: number): [number, number, number, number] {
  const r = (roll * Math.PI) / 360;
  const p = (pitch * Math.PI) / 360;
  const y = (yaw * Math.PI) / 360;
  const [sr, cr, sp, cp, sy, cy] = [Math.sin(r), Math.cos(r), Math.sin(p), Math.cos(p), Math.sin(y), Math.cos(y)];
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

describe("eulerFromNedQuat", () => {
  it("returns zero angles for the identity quaternion", () => {
    const e = eulerFromNedQuat([1, 0, 0, 0]);
    expect(e.roll).toBeCloseTo(0, 9);
    expect(e.pitch).toBeCloseTo(0, 9);
    expect(e.yaw).toBeCloseTo(0, 9);
  });

  const cases: [number, number, number][] = [
    [0, 0, 90],
    [0, 45, 0],
    [30, 0, 0],
    [10, 20, 30],
    [-35, 60, 145],
    [120, -40, -100],
    [-170, 12, 179],
    [45, 89.9, 20],
    [-60, -89.9, 200],
    [5, 89.99, -75],
  ];

  it.each(cases)("round-trips roll=%d pitch=%d yaw=%d", (roll, pitch, yaw) => {
    const e = eulerFromNedQuat(eulerToNedQuat(roll, pitch, yaw));
    const tol = Math.abs(pitch) > 89 ? 1e-4 : 1e-9;
    expect(Math.abs(wrap180(e.roll - roll))).toBeLessThan(tol);
    expect(Math.abs(e.pitch - pitch)).toBeLessThan(tol);
    expect(Math.abs(wrap180(e.yaw - yaw))).toBeLessThan(tol);
  });

  it("reports yaw as a 0–360° heading", () => {
    expect(eulerFromNedQuat(eulerToNedQuat(0, 0, -30)).yaw).toBeCloseTo(330, 9);
    expect(eulerFromNedQuat(eulerToNedQuat(0, 0, 90)).yaw).toBeCloseTo(90, 9);
  });

  it("stays finite and recovers pitch exactly at gimbal lock", () => {
    for (const pitch of [90, -90]) {
      const e = eulerFromNedQuat(eulerToNedQuat(25, pitch, 40));
      expect(Number.isFinite(e.roll) && Number.isFinite(e.yaw)).toBe(true);
      expect(e.pitch).toBeCloseTo(pitch, 6);
    }
  });
});

describe("TelemetryStats", () => {
  const frame = (ts: number, alt: number, extra: Partial<TelemetryFrame> = {}): TelemetryFrame => ({
    ts,
    quat: [1, 0, 0, 0],
    lat: 39.9334,
    lon: 32.8597,
    alt,
    state: "BOOST",
    ...extra,
  });

  it("locks the AGL baseline on the first frame", () => {
    const s = new TelemetryStats();
    expect(s.snapshot(0).hasFrame).toBe(false);

    s.update(frame(0, 850), 0);
    expect(s.snapshot(0)).toMatchObject({ originAlt: 850, agl: 0, hasFrame: true });

    s.update(frame(100, 900), 100);
    expect(s.snapshot(100)).toMatchObject({ originAlt: 850, agl: 50 });
  });

  it("tracks peak apogee and keeps it after descent", () => {
    const s = new TelemetryStats();
    for (const [i, alt] of [100, 150, 220, 180].entries()) s.update(frame(i * 1000, alt), i);
    const snap = s.snapshot(4);
    expect(snap.apogee).toBe(120);
    expect(snap.agl).toBe(80);
  });

  it("smooths vertical speed (Δalt/Δt) toward the true climb rate", () => {
    const s = new TelemetryStats();
    s.update(frame(0, 0), 0);
    expect(s.snapshot(0).vSpeed).toBe(0);

    // ts is in ms: 10 m per 1000 ms = 10 m/s
    s.update(frame(1000, 10), 1);
    const first = SMOOTH * 10;
    expect(s.snapshot(1).vSpeed).toBeCloseTo(first, 9);

    s.update(frame(2000, 20), 2);
    expect(s.snapshot(2).vSpeed).toBeCloseTo(first + SMOOTH * (10 - first), 9);

    for (let i = 3; i < 40; i++) s.update(frame(i * 1000, i * 10), i);
    expect(s.snapshot(40).vSpeed).toBeCloseTo(10, 3);
  });

  it("reports a negative vertical speed on descent", () => {
    const s = new TelemetryStats();
    s.update(frame(0, 500), 0);
    s.update(frame(1000, 480), 1);
    expect(s.snapshot(1).vSpeed).toBeCloseTo(-SMOOTH * 20, 9);
  });

  it("derives 3D speed from horizontal and vertical motion", () => {
    const s = new TelemetryStats();
    const lat = 39.9334;
    s.update(frame(0, 0, { lat }), 0);
    // scale factors are taken at the newer fix's latitude
    const north = 0.001 * metersPerDegree(lat + 0.001).lat;
    s.update(frame(1000, 0, { lat: lat + 0.001 }), 1);
    expect(s.snapshot(1).speed).toBeCloseTo(SMOOTH * north, 6);
    expect(s.snapshot(1).vSpeed).toBeCloseTo(0, 9);

    const v = new TelemetryStats();
    v.update(frame(0, 0), 0);
    v.update(frame(1000, 30), 1);
    expect(v.snapshot(1).speed).toBeCloseTo(SMOOTH * 30, 9);
  });

  it("skips derivatives when the timestamp does not advance", () => {
    const s = new TelemetryStats();
    s.update(frame(500, 0), 0);
    s.update(frame(500, 40), 1);
    s.update(frame(400, 60), 2);
    const snap = s.snapshot(2);
    expect(snap.vSpeed).toBe(0);
    expect(snap.speed).toBe(0);
    expect(snap.agl).toBe(60);
  });

  it("counts packets over a 1 s window for the rate", () => {
    const s = new TelemetryStats();
    for (let i = 0; i < 20; i++) s.update(frame(i * 50, 0), i * 50);
    expect(s.snapshot(950).rateHz).toBe(20);
    expect(s.snapshot(2500).rateHz).toBe(0);
  });

  it("reset clears the baseline, apogee and derivatives", () => {
    const s = new TelemetryStats();
    s.update(frame(0, 100), 0);
    s.update(frame(1000, 300), 1);
    s.reset();

    expect(s.snapshot(2)).toMatchObject({ originAlt: null, apogee: 0, vSpeed: 0, speed: 0, hasFrame: false });
    s.update(frame(2000, 700), 2);
    expect(s.snapshot(2)).toMatchObject({ originAlt: 700, agl: 0 });
  });
});
