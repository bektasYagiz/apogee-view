import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  Material,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { nedQuatToThree, OriginProjector } from "./coordinates";
import { createRocket, REST_HEIGHT } from "./rocketMesh";
import type { TelemetryFrame } from "./types";

const POS_RATE = 12;
const ATT_RATE = 14;

export class FlightScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly rocket = createRocket();
  private readonly projector = new OriginProjector();
  private readonly resizeObserver: ResizeObserver;
  private readonly targetPos = new Vector3(0, REST_HEIGHT, 0);
  // vertical nose-up on the pad until the first frame arrives
  private readonly targetQuat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  private rafId = 0;
  private lastTime = 0;
  private disposed = false;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.domElement.style.display = "block";
    container.appendChild(this.renderer.domElement);

    this.scene.background = new Color(0x080b10);
    this.camera = new PerspectiveCamera(55, 1, 0.1, 20000);
    this.camera.position.set(4, 2.5, 5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.8, 0);
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 5000;

    this.buildEnvironment();
    this.rocket.position.copy(this.targetPos);
    this.rocket.quaternion.copy(this.targetQuat);
    this.scene.add(this.rocket);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.rafId = requestAnimationFrame(this.tick);
  }

  pushFrame(frame: TelemetryFrame): void {
    const enu = this.projector.project(frame.lat, frame.lon, frame.alt);
    if (!enu || !frame.quat.every(Number.isFinite)) return;
    this.targetPos.set(enu.x, enu.y + REST_HEIGHT, enu.z);
    this.targetQuat.copy(nedQuatToThree(frame.quat));
  }

  resetOrigin(): void {
    this.projector.resetOrigin();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
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
    sun.position.set(30, 60, 20);
    this.scene.add(sun, new HemisphereLight(0x9bb8e0, 0x1a1d22, 0.9));

    const grid = new GridHelper(400, 80, 0x2f3b4a, 0x1a222c);
    this.scene.add(grid);

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

    this.rocket.position.lerp(this.targetPos, 1 - Math.exp(-POS_RATE * dt));
    this.rocket.quaternion.slerp(this.targetQuat, 1 - Math.exp(-ATT_RATE * dt));

    // keep the orbit offset while the target follows the airframe
    const follow = this.rocket.position.clone().add(new Vector3(0, 0.8, 0)).sub(this.controls.target);
    this.camera.position.add(follow);
    this.controls.target.add(follow);
    this.controls.update();

    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.tick);
  };
}
