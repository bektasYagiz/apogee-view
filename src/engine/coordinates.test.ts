import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { metersPerDegree, nedQuatToThree, OriginProjector } from "./coordinates";

const A = 6378137;
const E2 = 0.00669437999014;
const DEG = Math.PI / 180;

describe("metersPerDegree", () => {
  it("matches WGS84 reference values at the equator", () => {
    const m = metersPerDegree(0);
    // meridian: a(1-e²)·π/180, prime vertical: a·π/180
    expect(m.lat).toBeCloseTo(A * (1 - E2) * DEG, 6);
    expect(m.lon).toBeCloseTo(A * DEG, 6);
    expect(m.lat).toBeCloseTo(110574.27, 1);
    expect(m.lon).toBeCloseTo(111319.49, 1);
  });

  it("matches WGS84 reference values at 60° N", () => {
    const m = metersPerDegree(60);
    const w = Math.sqrt(1 - E2 * Math.sin(60 * DEG) ** 2);
    expect(m.lat).toBeCloseTo(((A * (1 - E2)) / w ** 3) * DEG, 6);
    expect(m.lon).toBeCloseTo((A / w) * Math.cos(60 * DEG) * DEG, 6);
    expect(Math.abs(m.lat - 111412.84)).toBeLessThan(1);
    expect(Math.abs(m.lon - 55799.98)).toBeLessThan(1);
  });

  it("is symmetric about the equator and degenerates in longitude at the pole", () => {
    expect(metersPerDegree(-45)).toEqual(metersPerDegree(45));
    expect(metersPerDegree(90).lon).toBeCloseTo(0, 6);
  });
});

describe("OriginProjector", () => {
  const lat0 = 39.9334;
  const lon0 = 32.8597;
  const alt0 = 850;

  it("locks the first valid fix as the origin", () => {
    const p = new OriginProjector();
    expect(p.locked).toBe(false);
    const o = p.project(lat0, lon0, alt0)!;
    expect(p.locked).toBe(true);
    expect(o.x).toBeCloseTo(0, 9);
    expect(o.y).toBeCloseTo(0, 9);
    expect(o.z).toBeCloseTo(0, 9);
  });

  it("maps north to -Z, east to +X and up to +Y", () => {
    const p = new OriginProjector();
    p.project(lat0, lon0, alt0);
    const m = metersPerDegree(lat0);

    const n = p.project(lat0 + 0.001, lon0, alt0)!;
    expect(n.z).toBeCloseTo(-0.001 * m.lat, 6);
    expect(n.x).toBeCloseTo(0, 9);
    expect(n.y).toBeCloseTo(0, 9);

    const e = p.project(lat0, lon0 + 0.001, alt0)!;
    expect(e.x).toBeCloseTo(0.001 * m.lon, 6);
    expect(e.z).toBeCloseTo(0, 9);

    const u = p.project(lat0, lon0, alt0 + 120)!;
    expect(u.y).toBeCloseTo(120, 9);
    expect(u.x).toBeCloseTo(0, 9);

    const s = p.project(lat0 - 0.001, lon0, alt0)!;
    expect(s.z).toBeGreaterThan(0);
  });

  it("ignores non-finite fixes without locking", () => {
    const p = new OriginProjector();
    expect(p.project(Number.NaN, lon0, alt0)).toBeNull();
    expect(p.project(lat0, Infinity, alt0)).toBeNull();
    expect(p.locked).toBe(false);
  });

  it("resetOrigin unlocks so the next fix becomes the new origin", () => {
    const p = new OriginProjector();
    p.project(lat0, lon0, alt0);
    const far = p.project(lat0 + 0.01, lon0 + 0.01, alt0 + 50)!;
    expect(far.y).toBeCloseTo(50, 9);

    p.resetOrigin();
    expect(p.locked).toBe(false);
    const o = p.project(lat0 + 0.01, lon0 + 0.01, alt0 + 50)!;
    expect(o.x).toBeCloseTo(0, 9);
    expect(o.y).toBeCloseTo(0, 9);
    expect(o.z).toBeCloseTo(0, 9);
  });
});

describe("nedQuatToThree", () => {
  const N = new Vector3(0, 0, -1);
  const E = new Vector3(1, 0, 0);
  const UP = new Vector3(0, 1, 0);
  const near = (a: Vector3, b: Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-9);
  const h = Math.SQRT1_2;

  it("maps the identity quaternion to the Three.js identity", () => {
    const q = nedQuatToThree([1, 0, 0, 0]);
    expect(q.x).toBeCloseTo(0, 12);
    expect(q.y).toBeCloseTo(0, 12);
    expect(q.z).toBeCloseTo(0, 12);
    expect(q.w).toBe(1);
  });

  it("normalizes its input", () => {
    const q = nedQuatToThree([2, 0, 0, 0]);
    expect(q.length()).toBeCloseTo(1, 12);
  });

  it("swaps NED components into (y, -z, -x, w)", () => {
    const q = nedQuatToThree([0.5, 0.1, 0.2, 0.3]);
    const raw = new Quaternion(0.2, -0.3, -0.1, 0.5).normalize();
    expect(q.angleTo(raw)).toBeLessThan(1e-9);
  });

  it("NED yaw +90° (about Down) swings north to east", () => {
    near(N.clone().applyQuaternion(nedQuatToThree([h, 0, 0, h])), E);
  });

  it("NED pitch +90° (about East) tips north up", () => {
    near(N.clone().applyQuaternion(nedQuatToThree([h, 0, h, 0])), UP);
  });

  it("NED roll +90° (about North) rolls east down", () => {
    near(E.clone().applyQuaternion(nedQuatToThree([h, h, 0, 0])), UP.clone().negate());
  });

  it("agrees with a direct NED rotation for an arbitrary attitude", () => {
    const q: [number, number, number, number] = [0.8, 0.3, -0.4, 0.2];
    const n = Math.hypot(...q);
    const [w, x, y, z] = q.map((c) => c / n);
    // v' = v + 2w(u×v) + 2u×(u×v) with u = (x, y, z) in NED
    const rotNed = ([vx, vy, vz]: number[]) => {
      const cx = [y * vz - z * vy, z * vx - x * vz, x * vy - y * vx];
      const dx = [y * cx[2] - z * cx[1], z * cx[0] - x * cx[2], x * cx[1] - y * cx[0]];
      return [vx + 2 * (w * cx[0] + dx[0]), vy + 2 * (w * cx[1] + dx[1]), vz + 2 * (w * cx[2] + dx[2])];
    };
    const toThree = ([n_, e, d]: number[]) => new Vector3(e, -d, -n_);

    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.5, 0.7]]) {
      near(toThree(v).applyQuaternion(nedQuatToThree(q)), toThree(rotNed(v)));
    }
  });
});
