import { Quaternion } from "three";

const WGS84_A = 6378137;
const WGS84_E2 = 0.00669437999014;
const DEG = Math.PI / 180;

export interface Enu {
  x: number;
  y: number;
  z: number;
}

export class OriginProjector {
  private origin: { lat: number; lon: number; alt: number } | null = null;
  private mPerDegLat = 0;
  private mPerDegLon = 0;

  get locked(): boolean {
    return this.origin !== null;
  }

  resetOrigin(): void {
    this.origin = null;
  }

  /** Returns null until a finite fix has locked the origin. */
  project(lat: number, lon: number, alt: number): Enu | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) return null;
    if (!this.origin) this.lock(lat, lon, alt);
    const o = this.origin!;
    return {
      x: (lon - o.lon) * this.mPerDegLon,
      y: alt - o.alt,
      z: -(lat - o.lat) * this.mPerDegLat,
    };
  }

  private lock(lat: number, lon: number, alt: number): void {
    this.origin = { lat, lon, alt };
    ({ lat: this.mPerDegLat, lon: this.mPerDegLon } = metersPerDegree(lat));
  }
}

/** Local tangent-plane scale factors at a reference latitude. */
export function metersPerDegree(lat: number): { lat: number; lon: number } {
  const phi = lat * DEG;
  const w = Math.sqrt(1 - WGS84_E2 * Math.sin(phi) ** 2);
  // meridian radius for northing, prime-vertical radius * cos(lat) for easting
  return {
    lat: ((WGS84_A * (1 - WGS84_E2)) / w ** 3) * DEG,
    lon: (WGS84_A / w) * Math.cos(phi) * DEG,
  };
}

export function nedQuatToThree(q: readonly [number, number, number, number]): Quaternion {
  const [w, x, y, z] = q;
  // NED (N,E,D) -> Three (-Z,+X,-Y) axis permutation, don't touch unless you like upside-down rockets
  return new Quaternion(y, -z, -x, w).normalize();
}
