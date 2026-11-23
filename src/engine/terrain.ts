import { Mesh, PlaneGeometry, Vector3 } from "three";
import { metersPerDegree } from "./coordinates";
import { TopoContourMaterial } from "./TopoContourMaterial";

const SIZE = 4000;
// 12.5 m between vertices: at or below the DEM's native pixel size (~10-19 m at zoom 13), so no relief is undersampled
const SEGMENTS = 320;
const VERTS = SEGMENTS + 1;
const HALF = SIZE / 2;
const STEP = SIZE / SEGMENTS;

const ZOOM = 13;
const TILE_PX = 256;
const MOSAIC_PX = TILE_PX * 3;

export type TileFetcher = (z: number, x: number, y: number) => Promise<ArrayBuffer>;

const fetchTileOverHttp =
  (signal: AbortSignal): TileFetcher =>
  async (z, x, y) => {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, { signal });
    if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: ${res.status}`);
    return res.arrayBuffer();
  };

// slippy-map Web Mercator tile coordinates (fractional) at ZOOM
const TILES = 2 ** ZOOM;
const tileX = (lon: number) => ((lon + 180) / 360) * TILES;
const tileY = (lat: number) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * TILES;

/** Catmull-Rom weights for the four taps around a fractional position t in [0, 1). */
function catmullRom(t: number, out: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = -0.5 * t3 + t2 - 0.5 * t;
  out[1] = 1.5 * t3 - 2.5 * t2 + 1;
  out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  out[3] = 0.5 * t3 - 0.5 * t2;
}

const wx = new Float64Array(4);
const wy = new Float64Array(4);

/**
 * Bicubic (Catmull-Rom) sample of a row-major grid at fractional cell coords, edges clamped.
 * Continuous in value and slope, so DEM texel boundaries don't show up as creases in the shading.
 */
function bicubic(grid: Float32Array, w: number, h: number, fx: number, fy: number): number {
  const x = Math.min(Math.max(fx, 0), w - 1);
  const y = Math.min(Math.max(fy, 0), h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  catmullRom(x - x0, wx);
  catmullRom(y - y0, wy);
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const row = Math.min(Math.max(y0 - 1 + j, 0), h - 1) * w;
    let rowSum = 0;
    for (let i = 0; i < 4; i++) rowSum += grid[row + Math.min(Math.max(x0 - 1 + i, 0), w - 1)] * wx[i];
    sum += rowSum * wy[j];
  }
  return sum;
}

/**
 * One [1 2 1]/4 pass in each direction. Source DEMs are often quantized to whole metres, which
 * turns gentle slopes into terraces that light up as stripes once normals are derived from them.
 */
function smoothGrid(grid: Float32Array, size: number): void {
  const tmp = new Float32Array(grid.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      tmp[i] = 0.25 * grid[i - (x > 0 ? 1 : 0)] + 0.5 * grid[i] + 0.25 * grid[i + (x < size - 1 ? 1 : 0)];
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      grid[i] = 0.25 * tmp[i - (y > 0 ? size : 0)] + 0.5 * tmp[i] + 0.25 * tmp[i + (y < size - 1 ? size : 0)];
    }
  }
}

async function fetchTileElevations(fetchTile: TileFetcher, x: number, y: number): Promise<Float32Array> {
  // no colour management: RGB channels are raw elevation bits, not colours
  const bmp = await createImageBitmap(new Blob([await fetchTile(ZOOM, x, y)], { type: "image/png" }), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const ctx = new OffscreenCanvas(TILE_PX, TILE_PX).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const px = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
  const out = new Float32Array(TILE_PX * TILE_PX);
  for (let i = 0; i < out.length; i++) {
    const k = i * 4;
    // Terrarium encoding: metres = R*256 + G + B/256 - 32768
    out[i] = px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
  }
  return out;
}

/** 3x3 tile mosaic centred on the tile holding (lat, lon); returns an elevation sampler. */
async function fetchMosaic(lat: number, lon: number, fetchTile: TileFetcher) {
  const tx0 = Math.floor(tileX(lon)) - 1;
  const ty0 = Math.floor(tileY(lat)) - 1;
  const mosaic = new Float32Array(MOSAIC_PX * MOSAIC_PX);
  const jobs: Promise<void>[] = [];
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const wrappedX = (((tx0 + dx) % TILES) + TILES) % TILES;
      jobs.push(
        fetchTileElevations(fetchTile, wrappedX, ty0 + dy).then((tile) => {
          for (let r = 0; r < TILE_PX; r++) {
            mosaic.set(tile.subarray(r * TILE_PX, (r + 1) * TILE_PX), (dy * TILE_PX + r) * MOSAIC_PX + dx * TILE_PX);
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  smoothGrid(mosaic, MOSAIC_PX);
  // pixel centres sit at +0.5, hence the shift before the lookup
  return (la: number, lo: number) =>
    bicubic(mosaic, MOSAIC_PX, MOSAIC_PX, (tileX(lo) - tx0) * TILE_PX - 0.5, (tileY(la) - ty0) * TILE_PX - 0.5);
}

export class TerrainMesh {
  readonly mesh: Mesh<PlaneGeometry, TopoContourMaterial>;
  private readonly heights = new Float32Array(VERTS * VERTS);
  private abort: AbortController | null = null;

  constructor(
    bgHex: number,
    sunDir: Vector3,
    private readonly tileFetcher?: TileFetcher,
  ) {
    const geo = new PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
    // plane rows run +Y..-Y; after this rotation vertex (ix, iz) lands at x = -HALF + ix*STEP, z = -HALF + iz*STEP
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, new TopoContourMaterial(HALF * 0.3, HALF * 0.98, bgHex, sunDir));
  }

  /**
   * Ground height (m, relative to the origin's ground) at local ENU (x, z), interpolated over the
   * same two triangles per cell that the mesh is drawn with, so it matches the rendered surface exactly.
   */
  sampleHeight(x: number, z: number): number {
    const gx = Math.min(Math.max((x + HALF) / STEP, 0), SEGMENTS);
    const gz = Math.min(Math.max((z + HALF) / STEP, 0), SEGMENTS);
    const ix = Math.min(Math.floor(gx), SEGMENTS - 1);
    const iz = Math.min(Math.floor(gz), SEGMENTS - 1);
    const tx = gx - ix;
    const tz = gz - iz;
    const h = this.heights;
    const a = h[iz * VERTS + ix];
    const b = h[(iz + 1) * VERTS + ix];
    const c = h[(iz + 1) * VERTS + ix + 1];
    const d = h[iz * VERTS + ix + 1];
    // PlaneGeometry splits each cell along b-d into triangles (a, b, d) and (b, c, d)
    return tx + tz <= 1 ? a + tx * (d - a) + tz * (b - a) : c + (1 - tx) * (b - c) + (1 - tz) * (d - c);
  }

  /** Resolves true once DEM relief is applied; false on any failure (terrain stays flat). */
  async loadAroundOrigin(lat0: number, lon0: number): Promise<boolean> {
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;
    try {
      const elevationAt = await fetchMosaic(lat0, lon0, this.tileFetcher ?? fetchTileOverHttp(ctrl.signal));
      if (ctrl.signal.aborted) return false;
      const base = elevationAt(lat0, lon0);
      if (!Number.isFinite(base)) return false;
      const m = metersPerDegree(lat0);
      for (let iz = 0; iz < VERTS; iz++) {
        const lat = lat0 - (iz * STEP - HALF) / m.lat;
        for (let ix = 0; ix < VERTS; ix++) {
          const lon = lon0 + (ix * STEP - HALF) / m.lon;
          this.heights[iz * VERTS + ix] = elevationAt(lat, lon) - base;
        }
      }
      this.apply(base);
      return true;
    } catch {
      return false;
    } finally {
      if (this.abort === ctrl) this.abort = null;
    }
  }

  reset(): void {
    this.abort?.abort();
    this.abort = null;
    this.heights.fill(0);
    this.apply(0);
  }

  dispose(): void {
    this.abort?.abort();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  /** Central-difference normals straight from the height grid: symmetric, with no triangle-direction bias. */
  private updateNormals(): void {
    const normals = this.mesh.geometry.attributes.normal;
    const h = this.heights;
    for (let iz = 0; iz < VERTS; iz++) {
      const zl = Math.max(iz - 1, 0);
      const zh = Math.min(iz + 1, VERTS - 1);
      for (let ix = 0; ix < VERTS; ix++) {
        const xl = Math.max(ix - 1, 0);
        const xh = Math.min(ix + 1, VERTS - 1);
        const dhdx = (h[iz * VERTS + xh] - h[iz * VERTS + xl]) / ((xh - xl) * STEP);
        const dhdz = (h[zh * VERTS + ix] - h[zl * VERTS + ix]) / ((zh - zl) * STEP);
        const inv = 1 / Math.hypot(dhdx, 1, dhdz);
        normals.setXYZ(iz * VERTS + ix, -dhdx * inv, inv, -dhdz * inv);
      }
    }
    normals.needsUpdate = true;
  }

  private apply(baseElevation: number): void {
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position;
    for (let i = 0; i < this.heights.length; i++) pos.setY(i, this.heights[i]);
    pos.needsUpdate = true;
    this.updateNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    this.mesh.material.baseElevation = baseElevation;
  }
}
