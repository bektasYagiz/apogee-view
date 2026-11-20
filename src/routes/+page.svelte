<script lang="ts">
  import { onMount } from "svelte";
  import { FlightScene } from "../engine/FlightScene";
  import type { CameraMode, TelemetryFrame } from "../engine/types";
  import HudOverlay from "$lib/components/HudOverlay.svelte";
  import ReplayBar from "$lib/components/ReplayBar.svelte";
  import { TelemetryStats, type LinkStatus } from "$lib/telemetryStats";

  const CAMERA_KEYS: Record<string, CameraMode> = {
    "1": "chase",
    "2": "pad",
    "3": "onboard",
    "4": "topdown",
  };
  const HUD_INTERVAL_MS = 1000 / 15;
  const SIGNAL_TIMEOUT_MS = 2000;

  const stats = new TelemetryStats();

  let container: HTMLDivElement;
  let scene: FlightScene | undefined;
  let camera = $state<CameraMode>("chase");
  let replaying = $state(false);
  let snap = $state.raw(stats.snapshot(0));
  let link = $state<LinkStatus>("WAITING");
  let lastLiveAt = 0;

  function feed(frames: TelemetryFrame[]) {
    const now = performance.now();
    for (const f of frames) {
      scene?.pushFrame(f);
      stats.update(f, now);
    }
  }

  function onLiveFrame(frame: TelemetryFrame) {
    if (replaying) return;
    lastLiveAt = performance.now();
    feed([frame]);
  }

  function resetOrigin() {
    if (replaying) return;
    scene?.resetOrigin();
    stats.reset();
  }

  function setCamera(mode: CameraMode) {
    camera = mode;
    scene?.setCameraMode(mode);
  }

  function enterReplay() {
    replaying = true;
    scene?.resetOrigin();
    stats.reset();
  }

  function exitReplay() {
    replaying = false;
    lastLiveAt = 0;
    scene?.resetOrigin();
    stats.reset();
  }

  function onReplayFrames(frames: TelemetryFrame[], rewind: boolean) {
    if (rewind) {
      scene?.clearTrail();
      stats.reset();
    }
    feed(frames);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    const mode = CAMERA_KEYS[e.key];
    if (mode) setCamera(mode);
    else if (e.key === "r" || e.key === "R") resetOrigin();
  }

  function refreshHud() {
    const now = performance.now();
    snap = stats.snapshot(now);
    link = replaying
      ? "REPLAY"
      : lastLiveAt === 0
        ? "WAITING"
        : now - lastLiveAt > SIGNAL_TIMEOUT_MS
          ? "NO SIGNAL"
          : "LIVE";
  }

  onMount(() => {
    const inTauri = "__TAURI_INTERNALS__" in window;
    const flight = new FlightScene(container, {
      tileFetcher: inTauri
        ? async (z, x, y) => {
            const { invoke } = await import("@tauri-apps/api/core");
            const bytes = await invoke<number[] | ArrayBuffer>("get_terrain_tile", { z, x, y });
            return bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
          }
        : undefined,
    });
    scene = flight;
    const hudTimer = setInterval(refreshHud, HUD_INTERVAL_MS);
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    if (inTauri) {
      import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen<TelemetryFrame>("telemetry://frame", (e) => onLiveFrame(e.payload)),
        )
        .then((fn) => (cancelled ? fn() : (unlisten = fn)))
        .catch((err) => console.error("telemetry subscribe failed", err));
    }

    return () => {
      cancelled = true;
      clearInterval(hudTimer);
      unlisten?.();
      scene = undefined;
      flight.dispose();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div bind:this={container} class="viewport"></div>

<HudOverlay {snap} {link} {camera} canReset={!replaying} onReset={resetOrigin} onCamera={setCamera} />
<ReplayBar onFrames={onReplayFrames} onEnter={enterReplay} onExit={exitReplay} />

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
    background: #080b10;
  }

  .viewport {
    width: 100vw;
    height: 100vh;
    background: #080b10;
  }
</style>
