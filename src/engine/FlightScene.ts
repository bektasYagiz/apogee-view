import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  BufferGeometry,
  DoubleSide,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineLoop,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  RingGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { nedQuatToThree, OriginProjector } from "./coordinates";
import { createRocket, REST_HEIGHT } from "./rocketMesh";
import { FlightTrail } from "./flightTrail";
import { TerrainMesh, type TileFetcher } from "./terrain";
import type { CameraMode, TelemetryFrame } from "./types";

const BG_HEX = 0x05070a;
const SUN_DIR = new Vector3(30, 60, 20);
const SCALE_RING_RADIUS = 50;
const SCALE_RING_SEGMENTS = 128;

const POS_RATE = 12;
const ATT_RATE = 14;
// CG height above the surface when the airframe lies on its side (body radius plus a little)
const LYING_CLEARANCE = 0.08;
const NOSE_AXIS = new Vector3(0, 0, -1);
const PAD_CAM_POS =new Vector3(12, 3, 12);
// A few centimetres south of straight overhead: OrbitControls can't sit exactly on the pole, and this keeps North (-Z) up on screen.
const TOPDOWN_OFFSET = new Vector3(0, 60, 0.06);
const CG_LOOK_OFFSET = new Vector3(0, 0.8, 0);
const NEAR_PLANE = 0.1;
const ONBOARD_NEAR_PLANE = 0.05;
// Pod just below the nose shoulder, in rocket-local space (nose is -Z, aft is +Z, CG at the origin).
// Airframe from rocketMesh: body radius 0.06 m, nose base at z = -0.465, nozzle at z = +0.815.
const BODY_RADIUS = 0.06;
const ONBOARD_POS = new Vector3(BODY_RADIUS + 0.18, 0, -0.365);
// Looks down the airframe past the fins toward the tail and the ground below.
const ONBOARD_LOOK = new Quaternion().setFromRotationMatrix(
  new Matrix4().lookAt(ONBOARD_POS, new Vector3(0, 0, 1.4), new Vector3(0, 1, 0)),
);

export class FlightScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly rocket = createRocket();
  private readonly projector = new OriginProjector();
  private readonly trail = new FlightTrail();
  private readonly terrain: TerrainMesh;
  private readonly scaleRing: LineLoop;
  private readonly scaleRingPositions = new Float32Array(SCALE_RING_SEGMENTS * 3);
  private readonly dropLine: Line;
  private readonly dropPositions = new Float32Array(6);
  private readonly nadir: Mesh;
  private readonly chaseOffset = new Vector3(4, 1.7, 5);
  private readonly tmpVec = new Vector3();
  private mode: CameraMode = "chase";
  private readonly resizeObserver: ResizeObserver;
  private readonly targetPos = new Vector3(0, REST_HEIGHT, 0);
  private phase = "UNKNOWN";
  private trailArmed = false;
  private rebuilding = true;
  // vertical nose-up on the pad until the first frame arrives
  private readonly targetQuat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  private rafId = 0;
  private lastTime = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    options: { tileFetcher?: TileFetcher } = {},
  ) {
    this.terrain = new TerrainMesh(BG_HEX, SUN_DIR, options.tileFetcher);
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.domElement.style.display = "block";
    container.appendChild(this.renderer.domElement);

    this.scene.background = new Color(BG_HEX);
    this.camera = new PerspectiveCamera(55, 1, NEAR_PLANE, 20000);
    this.camera.position.set(4, 2.5, 5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    // pan across the ground plane instead of sliding along the view, which would climb or sink in tilted views
    this.controls.screenSpacePanning = false;
    this.controls.panSpeed = 1.4;
    this.controls.target.set(0, 0.8, 0);
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 5000;

    this.buildEnvironment();

    const ringGeo = new BufferGeometry();
    ringGeo.setAttribute("position", new BufferAttribute(this.scaleRingPositions, 3));
    this.scaleRing = new LineLoop(
      ringGeo,
      new LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.55 }),
    );
    this.conformScaleRing();
    this.scene.add(this.terrain.mesh, this.scaleRing);

    const dropGeo = new BufferGeometry();
    dropGeo.setAttribute("position", new BufferAttribute(this.dropPositions, 3));
    this.dropLine = new Line(
      dropGeo,
      new LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.45 }),
    );
    this.dropLine.frustumCulled = false;
    this.nadir = new Mesh(
      new RingGeometry(0.25, 0.32, 32),
      new MeshBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.7, side: DoubleSide }),
    );
    this.nadir.rotation.x = -Math.PI / 2;
    this.scene.add(this.trail.object, this.dropLine, this.nadir);

    this.rocket.position.copy(this.targetPos);
    this.rocket.quaternion.copy(this.targetQuat);
    this.scene.add(this.rocket);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.rafId = requestAnimationFrame(this.tick);
  }

  pushFrame(frame: TelemetryFrame): void {
    const wasLocked = this.projector.locked;
    const enu = this.projector.project(frame.lat, frame.lon, frame.alt);
    if (!wasLocked && this.projector.locked) {
      void this.terrain.loadAroundOrigin(frame.lat, frame.lon).then((ok) => {
        if (ok && !this.disposed) this.conformScaleRing();
      });
    }
    if (!enu || !frame.quat.every(Number.isFinite)) return;
    this.targetQuat.copy(nedQuatToThree(frame.quat));
    // the mesh's nose axis sits on -Z (not local +Y), so its world-y component is how upright the airframe is
    const upright = Math.abs(this.tmpVec.copy(NOSE_AXIS).applyQuaternion(this.targetQuat).y);
    const clearance = LYING_CLEARANCE + (REST_HEIGHT - LYING_CLEARANCE) * upright;
    const groundY = this.getGroundHeight(enu.x, enu.z);
    this.targetPos.set(enu.x, Math.max(enu.y + clearance, groundY + clearance), enu.z);
    this.phase = frame.state;
    // History after a reset or rewind arrives as a burst the damped rocket can't trace, so it goes straight in.
    if (this.rebuilding) this.trail.push(this.targetPos, frame.state);
    this.trailArmed = true;
  }

  resetOrigin(): void {
    this.projector.resetOrigin();
    this.restartTrail();
    this.terrain.reset();
    this.conformScaleRing();
  }

  /** Drops trail history but keeps the locked origin and terrain; used when rewinding a replay. */
  clearTrail(): void {
    this.restartTrail();
  }

  /**
   * Marks a timeline jump that keeps the trail: frames fed next go straight into it, and the
   * rocket snaps to the last one instead of damping across the gap (which would draw a chord).
   */
  snapToTarget(): void {
    this.rebuilding = true;
  }

  private restartTrail(): void {
    this.trail.clear();
    this.trailArmed = false;
    this.rebuilding = true;
  }

  getGroundHeight(x: number, z: number): number {
    return this.terrain.sampleHeight(x, z);
  }

  setCameraMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    if (this.mode === "chase") {
      this.chaseOffset.copy(this.camera.position).sub(this.controls.target);
    }
    this.mode = mode;
    this.camera.up.set(0, 1, 0);
    // tighter near plane only on the pod camera so far-field depth precision stays intact elsewhere
    this.camera.near = mode === "onboard" ? ONBOARD_NEAR_PLANE : NEAR_PLANE;
    this.camera.updateProjectionMatrix();
    this.controls.enabled = mode !== "onboard";
    // Chase re-centres the target on the rocket every frame, so a pan would only fight it and jitter.
    this.controls.enablePan = mode === "pad" || mode === "topdown";
    switch (mode) {
      case "chase":
        this.controls.target.copy(this.rocket.position).add(CG_LOOK_OFFSET);
        this.camera.position.copy(this.controls.target).add(this.chaseOffset);
        break;
      case "pad":
        this.controls.target.copy(this.rocket.position);
        this.camera.position.copy(PAD_CAM_POS);
        break;
      case "topdown":
        this.controls.target.copy(this.rocket.position);
        this.camera.position.copy(this.rocket.position).add(TOPDOWN_OFFSET);
        break;
    }
    if (mode !== "onboard") this.controls.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.trail.dispose();
    this.terrain.dispose();
    const materials = new Set<Material>();
    this.scene.traverse((obj) => {
      if (!(obj instanceof Mesh) && !("geometry" in obj)) return;
      const mesh = obj as Mesh;
      mesh.geometry?.dispose();
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (m) materials.add(m);
      }
    });
    materials.forEach((m) => m.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private buildEnvironment(): void {
    const sun = new DirectionalLight(0xfff2dd, 2.6);
    sun.position.copy(SUN_DIR);
    this.scene.add(sun, new HemisphereLight(0x9bb8e0, 0x1a1d22, 0.9));

    const padMat = new MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.9 });
    const pad = new Mesh(new CylinderGeometry(2, 2, 0.05, 48), padMat);
    pad.position.y = -0.025;
    this.scene.add(pad);

    const ring = new Mesh(
      new CircleGeometry(1.9, 48),
      new MeshStandardMaterial({ color: 0x5a6470, roughness: 0.8 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    this.scene.add(ring);

    const northMat = new MeshStandardMaterial({ color: 0xd2452b });
    const eastMat = new MeshStandardMaterial({ color: 0x3f8fd2 });
    const north = new Mesh(new BoxGeometry(0.12, 0.02, 1.6), northMat);
    north.position.set(0, 0.01, -1.0);
    const east = new Mesh(new BoxGeometry(1.6, 0.02, 0.12), eastMat);
    east.position.set(1.0, 0.01, 0);
    this.scene.add(north, east);
  }

  /** Drapes the 50 m scale ring over the current terrain heightfield. */
  private conformScaleRing(): void {
    for (let i = 0; i < SCALE_RING_SEGMENTS; i++) {
      const a = (i / SCALE_RING_SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * SCALE_RING_RADIUS;
      const z = Math.sin(a) * SCALE_RING_RADIUS;
      this.scaleRingPositions.set([x, this.getGroundHeight(x, z) + 0.15, z], i * 3);
    }
    const geo = this.scaleRing.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();
  }

  private updateDropLine(): void {
    const { x, y, z } = this.rocket.position;
    const ground = this.getGroundHeight(x, z);
    this.dropPositions.set([x, y, z, x, ground, z]);
    this.dropLine.geometry.attributes.position.needsUpdate = true;
    this.nadir.position.set(x, ground + 0.02, z);
  }

  private updateCamera(): void {
    const p = this.rocket.position;
    switch (this.mode) {
      case "chase": {
        // keep the orbit offset while the target follows the airframe
        const follow = this.tmpVec.copy(p).add(CG_LOOK_OFFSET).sub(this.controls.target);
        this.camera.position.add(follow);
        this.controls.target.add(follow);
        this.controls.update();
        break;
      }
      // free-look: the pose is set once on entering the mode and the controls own it from then on
      case "pad":
      case "topdown":
        this.controls.update();
        break;
      case "onboard":
        this.camera.position.copy(ONBOARD_POS).applyQuaternion(this.rocket.quaternion).add(p);
        this.camera.quaternion.copy(this.rocket.quaternion).multiply(ONBOARD_LOOK);
        break;
    }
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private readonly tick = (now: number): void => {
    if (this.disposed) return;
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = now;

    if (this.rebuilding && this.trailArmed) {
      this.rocket.position.copy(this.targetPos);
      this.rocket.quaternion.copy(this.targetQuat);
      this.rebuilding = false;
    } else {
      this.rocket.position.lerp(this.targetPos, 1 - Math.exp(-POS_RATE * dt));
      this.rocket.quaternion.slerp(this.targetQuat, 1 - Math.exp(-ATT_RATE * dt));
    }
    // trail follows the rendered CG so it never runs ahead of the airframe
    if (this.trailArmed) this.trail.push(this.rocket.position, this.phase);

    this.updateDropLine();
    this.updateCamera();

    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.tick);
  };
}
