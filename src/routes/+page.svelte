<script lang="ts">
  import { onMount } from "svelte";
  import { FlightScene } from "../engine/FlightScene";
  import type { CameraMode, TelemetryFrame } from "../engine/types";

  const CAMERA_KEYS: Record<string, CameraMode> = {
    "1": "chase",
    "2": "pad",
    "3": "onboard",
    "4": "topdown",
  };

  let container: HTMLDivElement;
  let scene: FlightScene | undefined;

  function onKeydown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const mode = CAMERA_KEYS[e.key];
    if (mode) scene?.setCameraMode(mode);
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
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    if (inTauri) {
      import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen<TelemetryFrame>("telemetry://frame", (e) => flight.pushFrame(e.payload)),
        )
        .then((fn) => (cancelled ? fn() : (unlisten = fn)))
        .catch((err) => console.error("telemetry subscribe failed", err));
    }

    return () => {
      cancelled = true;
      unlisten?.();
      scene = undefined;
      flight.dispose();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div bind:this={container} class="viewport"></div>

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
