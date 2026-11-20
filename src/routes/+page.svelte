<script lang="ts">
  import { onMount } from "svelte";
  import { FlightScene } from "../engine/FlightScene";
  import type { TelemetryFrame } from "../engine/types";

  let container: HTMLDivElement;

  onMount(() => {
    const scene = new FlightScene(container);
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    if ("__TAURI_INTERNALS__" in window) {
      import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen<TelemetryFrame>("telemetry://frame", (e) => scene.pushFrame(e.payload)),
        )
        .then((fn) => (cancelled ? fn() : (unlisten = fn)))
        .catch((err) => console.error("telemetry subscribe failed", err));
    }

    return () => {
      cancelled = true;
      unlisten?.();
      scene.dispose();
    };
  });
</script>

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
