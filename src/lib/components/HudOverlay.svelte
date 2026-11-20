<script lang="ts">
  import type { CameraMode } from "../../engine/types";
  import {
    PHASE_CSS,
    PHASE_FALLBACK_CSS,
    type LinkStatus,
    type StatsSnapshot,
  } from "../telemetryStats";

  interface Props {
    snap: StatsSnapshot;
    link: LinkStatus;
    camera: CameraMode;
    canReset: boolean;
    onReset: () => void;
    onCamera: (mode: CameraMode) => void;
  }

  let { snap, link, camera, canReset, onReset, onCamera }: Props = $props();

  const CAMERAS: { mode: CameraMode; key: string; label: string }[] = [
    { mode: "chase", key: "1", label: "Chase" },
    { mode: "pad", key: "2", label: "Pad" },
    { mode: "onboard", key: "3", label: "Onboard" },
    { mode: "topdown", key: "4", label: "Top-Down" },
  ];

  const phaseColor = $derived(PHASE_CSS[snap.state.toUpperCase()] ?? PHASE_FALLBACK_CSS);
  const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
  const signed = (v: number, d = 1) => (v >= 0 ? "+" : "") + fmt(v, d);
</script>

<div class="hud">
  <section class="card top-left">
    <div class="row">
      <span class="phase" style:--c={phaseColor}>{snap.hasFrame ? snap.state : "NO DATA"}</span>
      <span class="link" class:ok={link === "LIVE"} class:replay={link === "REPLAY"} class:bad={link === "NO SIGNAL"}>
        <i></i>{link}
      </span>
    </div>
    <div class="row">
      <span class="dim">{link === "REPLAY" ? "FRAMES" : "RATE"} {fmt(snap.rateHz, 0)} Hz</span>
      <button type="button" disabled={!canReset} onclick={onReset} title="Re-lock launch origin">
        Reset Origin <kbd>R</kbd>
      </button>
    </div>
  </section>

  <section class="card top-right" aria-label="Camera">
    {#each CAMERAS as c (c.mode)}
      <button type="button" class:active={camera === c.mode} onclick={() => onCamera(c.mode)}>
        <kbd>{c.key}</kbd> {c.label}
      </button>
    {/each}
  </section>

  <section class="card bottom-left">
    <dl>
      <dt>ALT (AGL)</dt><dd>{fmt(snap.agl)} <u>m</u></dd>
      <dt>APOGEE</dt><dd>{fmt(snap.apogee)} <u>m</u></dd>
      <dt>VEL</dt><dd>{fmt(snap.speed)} <u>m/s</u></dd>
      <dt>V-SPD</dt><dd>{signed(snap.vSpeed)} <u>m/s</u></dd>
      <dt>PITCH</dt><dd>{signed(snap.pitch)} <u>°</u></dd>
      <dt>YAW</dt><dd>{fmt(snap.yaw)} <u>°</u></dd>
      <dt>ROLL</dt><dd>{signed(snap.roll)} <u>°</u></dd>
      <dt>LAT</dt><dd>{fmt(snap.lat, 6)}</dd>
      <dt>LON</dt><dd>{fmt(snap.lon, 6)}</dd>
    </dl>
  </section>
</div>

<style>
  .hud {
    position: fixed;
    inset: 0;
    pointer-events: none;
    font-family: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
    font-size: 12px;
    color: #cbd5e1;
    user-select: none;
  }

  .card {
    position: absolute;
    pointer-events: auto;
    padding: 8px 10px;
    background: rgba(8, 12, 18, 0.78);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 6px;
    font-variant-numeric: tabular-nums;
  }

  .top-left {
    top: 12px;
    left: 12px;
    display: grid;
    gap: 8px;
  }
  .top-right {
    top: 12px;
    right: 12px;
    display: flex;
    gap: 4px;
  }
  .bottom-left {
    bottom: 12px;
    left: 12px;
    min-width: 190px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .phase {
    padding: 2px 8px;
    border-radius: 3px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #05070a;
    background: var(--c);
  }

  .link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    letter-spacing: 0.08em;
    color: #94a3b8;
  }
  .link i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .link.ok {
    color: #10b981;
  }
  .link.ok i {
    animation: beat 1.2s ease-in-out infinite;
  }
  .link.replay {
    color: #38bdf8;
  }
  .link.bad {
    color: #f97316;
  }
  @keyframes beat {
    50% {
      opacity: 0.25;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .link.ok i {
      animation: none;
    }
  }

  .dim {
    color: #94a3b8;
  }

  button {
    font: inherit;
    color: #cbd5e1;
    background: transparent;
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 4px;
    padding: 3px 8px;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: rgba(148, 163, 184, 0.6);
  }
  button:focus-visible {
    outline: 2px solid #38bdf8;
    outline-offset: 1px;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button.active {
    color: #05070a;
    background: #cbd5e1;
    border-color: #cbd5e1;
  }
  button.active kbd {
    color: #334155;
  }

  kbd {
    font: inherit;
    color: #64748b;
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 14px;
    margin: 0;
  }
  dt {
    color: #64748b;
    letter-spacing: 0.06em;
  }
  dd {
    margin: 0;
    text-align: right;
    color: #e2e8f0;
  }
  u {
    text-decoration: none;
    color: #64748b;
  }
</style>
