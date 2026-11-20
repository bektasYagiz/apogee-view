<script lang="ts">
  import { onDestroy } from "svelte";
  import type { TelemetryFrame } from "../../engine/types";

  interface Props {
    /** Feeds frames to the scene; `rewind` means clear history first (frames start at index 0). */
    onFrames: (frames: TelemetryFrame[], rewind: boolean) => void;
    /** A log was opened: pause live forwarding and reset origin/stats. */
    onEnter: () => void;
    /** Back to live: reset origin/stats and resume forwarding. */
    onExit: () => void;
  }

  let { onFrames, onEnter, onExit }: Props = $props();

  const SPEEDS = [1, 2, 5];
  const FALLBACK_FRAME_MS = 20;
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  let logs = $state<string[]>([]);
  let selected = $state("");
  let error = $state("");
  let frames = $state.raw<TelemetryFrame[]>([]);
  let replaying = $state(false);
  let playing = $state(false);
  let speed = $state(1);
  let index = $state(0);

  // elapsed log time per frame (ms), forced monotonic so odd logs can't stall playback
  let times = $state.raw<number[]>([]);
  let playhead = 0;
  let raf = 0;
  let lastNow = 0;

  async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }

  async function refresh() {
    if (!inTauri) return;
    try {
      logs = (await call<string[]>("list_flight_logs")).slice().reverse();
      if (!logs.includes(selected)) selected = logs[0] ?? "";
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function open() {
    if (!inTauri || !selected) return;
    try {
      const loaded = await call<TelemetryFrame[]>("load_flight_log", { filename: selected });
      if (loaded.length === 0) {
        error = "log is empty";
        return;
      }
      error = "";
      stopLoop();
      frames = loaded;
      const t0 = loaded[0].ts;
      times = loaded.map(() => 0);
      for (let i = 1; i < loaded.length; i++) times[i] = Math.max(times[i - 1], loaded[i].ts - t0);
      if (times[times.length - 1] === 0) times = loaded.map((_, i) => i * FALLBACK_FRAME_MS);
      replaying = true;
      onEnter();
      index = 0;
      playhead = 0;
      onFrames([loaded[0]], true);
      play();
    } catch (e) {
      error = String(e);
    }
  }

  function exit() {
    stopLoop();
    replaying = false;
    frames = [];
    onExit();
  }

  function seek(target: number) {
    const i = Math.max(0, Math.min(frames.length - 1, Math.round(target)));
    if (i === index) return;
    if (i < index) onFrames(frames.slice(0, i + 1), true);
    else onFrames(frames.slice(index + 1, i + 1), false);
    index = i;
    playhead = times[i];
  }

  function tick(now: number) {
    playhead += (now - lastNow) * speed;
    lastNow = now;
    let next = index;
    while (next + 1 < frames.length && times[next + 1] <= playhead) next++;
    if (next !== index) {
      onFrames(frames.slice(index + 1, next + 1), false);
      index = next;
    }
    if (index >= frames.length - 1) {
      playing = false;
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!replaying) return;
    // restart from the top when play is pressed at the end
    if (index >= frames.length - 1) seek(0);
    playing = true;
    lastNow = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    cancelAnimationFrame(raf);
    playing = false;
  }

  function toggle() {
    if (playing) stopLoop();
    else play();
  }

  function onSlider(e: Event) {
    seek(Number((e.currentTarget as HTMLInputElement).value));
  }

  function onKeydown(e: KeyboardEvent) {
    if (!replaying || e.code !== "Space") return;
    const t = e.target;
    if (t instanceof HTMLSelectElement || t instanceof HTMLButtonElement) return;
    e.preventDefault();
    toggle();
  }

  const clock = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  void refresh();
  onDestroy(stopLoop);
</script>

<svelte:window onkeydown={onKeydown} />

{#if inTauri}
  <section class="bar" aria-label="Flight replay">
    {#if replaying}
      <button type="button" onclick={toggle} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <input
        type="range"
        min="0"
        max={frames.length - 1}
        value={index}
        oninput={onSlider}
        aria-label="Replay position"
      />
      <span class="clock">{clock(times[index] ?? 0)} / {clock(times[times.length - 1] ?? 0)}</span>
      <div class="speeds" role="group" aria-label="Playback speed">
        {#each SPEEDS as s (s)}
          <button type="button" class:active={speed === s} onclick={() => (speed = s)}>{s}x</button>
        {/each}
      </div>
      <button type="button" onclick={exit}>Live</button>
    {:else}
      <select bind:value={selected} aria-label="Recorded flight" disabled={logs.length === 0}>
        {#if logs.length === 0}
          <option value="">no recorded flights</option>
        {/if}
        {#each logs as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
      <button type="button" onclick={refresh}>Refresh</button>
      <button type="button" onclick={open} disabled={!selected}>Replay</button>
    {/if}
    {#if error}<span class="err" title={error}>{error}</span>{/if}
  </section>
{/if}

<style>
  .bar {
    position: fixed;
    right: 12px;
    bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: min(560px, calc(100vw - 260px));
    padding: 8px 10px;
    background: rgba(8, 12, 18, 0.78);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 6px;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
    font-size: 12px;
    color: #cbd5e1;
    font-variant-numeric: tabular-nums;
  }

  button,
  select {
    font: inherit;
    color: #cbd5e1;
    background: transparent;
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 4px;
    padding: 3px 8px;
    cursor: pointer;
  }
  select {
    min-width: 0;
    max-width: 220px;
    background: rgba(8, 12, 18, 0.9);
  }
  button:hover:not(:disabled) {
    border-color: rgba(148, 163, 184, 0.6);
  }
  button:focus-visible,
  select:focus-visible,
  input:focus-visible {
    outline: 2px solid #38bdf8;
    outline-offset: 1px;
  }
  button:disabled,
  select:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button.active {
    color: #05070a;
    background: #cbd5e1;
    border-color: #cbd5e1;
  }

  input[type="range"] {
    flex: 1;
    min-width: 120px;
    accent-color: #38bdf8;
  }
  .clock {
    white-space: nowrap;
    color: #94a3b8;
  }
  .speeds {
    display: flex;
    gap: 4px;
  }
  .err {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #f97316;
  }
</style>
