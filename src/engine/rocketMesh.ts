import {
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
} from "three";

const RADIUS = 0.06;
const BODY_LEN = 1.2;
const NOSE_LEN = 0.35;
const NOZZLE_LEN = 0.08;
const TOTAL_LEN = NOZZLE_LEN + BODY_LEN + NOSE_LEN;

/** Height of the geometric midpoint above the pad when the rocket stands on its nozzle. */
export const REST_HEIGHT = TOTAL_LEN / 2;

function finGeometry(): BufferGeometry {
  const t = 0.003;
  const root = 0.3;
  const tip = 0.12;
  const span = 0.14;
  const sweep = 0.14;
  const r = RADIUS;
  // trapezoid in the XY plane, extruded as a thin double-sided slab
  const pts = [
    [r, 0],
    [r + span, sweep],
    [r + span, sweep + tip],
    [r, root],
  ];
  const pos: number[] = [];
  const idx: number[] = [];
  for (const z of [-t, t]) for (const [x, y] of pts) pos.push(x, y, z);
  idx.push(0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    idx.push(i, i + 4, j, j, i + 4, j + 4);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Nose along +Y; wrapped so body +Y lands on NED forward (-Z) at identity attitude. */
export function createRocket(): Group {
  const root = new Group();
  const model = new Group();
  model.rotation.x = -Math.PI / 2;
  // model +Y maps to root -Z after the rotation, so shift +Z to pull the midpoint onto the origin
  model.position.z = REST_HEIGHT - NOZZLE_LEN;
  root.add(model);

  const bodyMat = new MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.5, metalness: 0.2 });
  const noseMat = new MeshStandardMaterial({ color: 0xd2452b, roughness: 0.45 });
  const finMat = new MeshStandardMaterial({ color: 0x2b3a4a, roughness: 0.6, side: 2 });
  const nozzleMat = new MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4, metalness: 0.8 });

  const body = new Mesh(new CylinderGeometry(RADIUS, RADIUS, BODY_LEN, 24), bodyMat);
  body.position.y = BODY_LEN / 2;

  const nose = new Mesh(new ConeGeometry(RADIUS, NOSE_LEN, 24), noseMat);
  nose.position.y = BODY_LEN + NOSE_LEN / 2;

  const nozzle = new Mesh(new CylinderGeometry(RADIUS * 0.5, RADIUS * 0.7, NOZZLE_LEN, 20), nozzleMat);
  nozzle.position.y = -NOZZLE_LEN / 2;

  model.add(body, nose, nozzle);

  const finGeo = finGeometry();
  for (let i = 0; i < 4; i++) {
    const fin = new Mesh(finGeo, finMat);
    fin.rotation.y = (i * Math.PI) / 2;
    model.add(fin);
  }

  return root;
}
