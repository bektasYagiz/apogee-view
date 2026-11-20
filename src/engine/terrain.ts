import { Mesh, PlaneGeometry, Vector3 } from "three";
import { metersPerDegree } from "./coordinates";
import { TopoContourMaterial } from "./TopoContourMaterial";

const SIZE = 4000;
const SEGMENTS = 160;
const VERTS = SEGMENTS + 1;
const HALF = SIZE / 2;
const STEP = SIZE / SEGMENTS;

const ZOOM = 13;
const TILE_PX = 256;
const MOSAIC_PX = TILE_PX * 3;
const tileUrl = (x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`;

// slippy-map Web Mercator tile coordinates (fractional) at ZOOM
const TILES = 2 ** ZOOM;
const tileX = (lon: number) => ((lon + 180) / 360) * TILES;
const tileY = (lat: number) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * TILES;

/** Bilinear sample of a row-major grid at fractional cell coords, clamped to the edges. */
function bilerp(grid: Float32Array, w: number, h: number, fx: number, fy: number): number {
  const x = Math.min(Math.max(fx, 0), w - 1);
  const y = Math.min(Math.max(fy, 0), h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = x - x0;
  const ty = y - y0;
  const top = grid[y0 * w + x0] * (1 - tx) + grid[y0 * w + x1] * tx;
  const bot = grid[y1 * w + x0] * (1 - tx) + grid[y1 * w + x1] * tx;
  return top * (1 - ty) + bot * ty;
}

async function fetchTileElevations(x: number, y: number, signal: AbortSignal): Promise<Float32Array> {
  const res = await fetch(tileUrl(x, y), { signal });
  if (!res.ok) throw new Error(`tile ${x}/${y}: ${res.status}`);
  // no colour management: RGB channels are raw elevation bits, not colours
  const bmp = await createImageBitmap(await res.blob(), {
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
async function fetchMosaic(lat: number, lon: number, signal: AbortSignal) {
  const tx0 = Math.floor(tileX(lon)) - 1;
  const ty0 = Math.floor(tileY(lat)) - 1;
  const mosaic = new Float32Array(MOSAIC_PX * MOSAIC_PX);
  const jobs: Promise<void>[] = [];
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const wrappedX = (((tx0 + dx) % TILES) + TILES) % TILES;
      jobs.push(
        fetchTileElevations(wrappedX, ty0 + dy, signal).then((tile) => {
          for (let r = 0; r < TILE_PX; r++) {
            mosaic.set(tile.subarray(r * TILE_PX, (r + 1) * TILE_PX), (dy * TILE_PX + r) * MOSAIC_PX + dx * TILE_PX);
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  // pixel centres sit at +0.5, hence the shift before bilinear lookup
  return (la: number, lo: number) =>
    bilerp(mosaic, MOSAIC_PX, MOSAIC_PX, (tileX(lo) - tx0) * TILE_PX - 0.5, (tileY(la) - ty0) * TILE_PX - 0.5);
}

export class TerrainMesh {
  readonly mesh: Mesh<PlaneGeometry, TopoContourMaterial>;
  private readonly heights = new Float32Array(VERTS * VERTS);
  private abort: AbortController | null = null;

  constructor(bgHex: number, sunDir: Vector3) {
    const geo = new PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS);
    // plane rows run +Y..-Y; after this rotation vertex (ix, iz) lands at x = -HALF + ix*STEP, z = -HALF + iz*STEP
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, new TopoContourMaterial(HALF * 0.3, HALF * 0.98, bgHex, sunDir));
  }

  /** Ground height (m, relative to the origin's ground) at local ENU (x, z). */
  sampleHeight(x: number, z: number): number {
    return bilerp(this.heights, VERTS, VERTS, (x + HALF) / STEP, (z + HALF) / STEP);
  }

  /** Resolves true once DEM relief is applied; false on any failure (terrain stays flat). */
  async loadAroundOrigin(lat0: number, lon0: number): Promise<boolean> {
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;
    try {
      const elevationAt = await fetchMosaic(lat0, lon0, ctrl.signal);
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

  private apply(baseElevation: number): void {
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position;
    for (let i = 0; i < this.heights.length; i++) pos.setY(i, this.heights[i]);
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    this.mesh.material.baseElevation = baseElevation;
  }
}
