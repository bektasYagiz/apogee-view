# Apogee View: Architecture

Apogee View is an offline-first 3D flight telemetry visualizer and blackbox replay tool. A Tauri v2 backend (Rust) receives telemetry over a UDP loopback socket, normalizes it, records it to disk, and forwards it to a SvelteKit + Three.js frontend running in the WebView.

This document describes how the code works today: the data path, the wire protocol, the coordinate math, and the rendering invariants that are easy to break. File and symbol names are exact so you can grep for them.

## Contents

1. [System overview and data pipeline](#1-system-overview-and-data-pipeline)
2. [Architectural decisions and trade-offs](#2-architectural-decisions-and-trade-offs)
3. [Telemetry wire protocol](#3-telemetry-wire-protocol)
4. [Coordinate frames and attitude mathematics](#4-coordinate-frames-and-attitude-mathematics)
5. [Rendering and GPU synchronization](#5-rendering-and-gpu-synchronization)
6. [Known limits](#6-known-limits)

---

## 1. System overview and data pipeline

```
 +---------------------------+
 | Telemetry source          |   flight computer, radio ground-station relay,
 | (any language)            |   or examples/mock_flight.py
 +-------------+-------------+
               | UDP datagrams (JSON or 42-byte binary)
               v
        127.0.0.1:5005
               |
 ==============|============================ Rust backend (src-tauri/src/) ==
               v
 +---------------------------+
 | udp.rs                    |  tokio UdpSocket, 2048-byte datagram buffer.
 |  recv_loop                |  Bad packets are counted; one log line for the
 |                           |  first and then every 100th drop.
 +-------------+-------------+
               | &[u8]
               v
 +---------------------------+
 | protocol.rs               |  parse_packet(): first byte picks the decoder.
 |  parse_packet             |  Rejects NaN/Inf, normalizes the quaternion,
 |                           |  Euler (ZYX, degrees) -> unit quaternion.
 +-------------+-------------+
               | TelemetryFrame { ts, quat[w,x,y,z], lat, lon, alt, state }
        +------+---------------------------+
        |                                  |
        v                                  v
 +---------------------+        +------------------------------+
 | Tauri event         |        | recorder.rs                  |
 | "telemetry://frame" |        |  bounded mpsc (1024), try_send|
 +----------+----------+        |  -> write_loop task           |
            |                   |  lazily creates flight_<s>.jsonl|
            |                   |  on the first frame, flush/50 |
            |                   +--------------+---------------+
            |                                  v
            |                   app_data_dir()/flights/*.jsonl
            |                                  ^
            |                                  | list_flight_logs / load_flight_log (IPC commands)
 ===========|==================================|======= WebView (src/) =====
            v                                  |
 +---------------------------------------------+---------+
 | routes/+page.svelte                                    |
 |  live listener, replay switch, 15 Hz HUD refresh       |
 +------+--------------------------------------+----------+
        |                                      |
        v                                      v
 +----------------------+            +----------------------+
 | lib/telemetryStats.ts|            | lib/components/      |
 |  AGL baseline, apogee|            |  HudOverlay.svelte   |
 |  speed, v-speed,     |            |  ReplayBar.svelte    |
 |  IDLE/FLIGHT phase   |            +----------------------+
 +----------+-----------+
            | resolved TelemetryFrame
            v
 +--------------------------------------------------------+
 | engine/ (pure TypeScript + three, no Svelte/Tauri)     |
 |  coordinates.ts   WGS84 tangent plane, NED -> Three.js |
 |  FlightScene.ts   rAF loop, damping, camera rigs       |
 |  flightTrail.ts   phase-colored trail, GPU dirty range |
 |  terrain.ts       DEM mesh + bilinear height sampler   |
 |  TopoContourMaterial.ts   fwidth() contour shader      |
 +--------------------------------------------------------+
```

### Backend (`src-tauri/src/`)

- **`udp.rs`** binds `127.0.0.1:5005` with a `tokio` `UdpSocket` and loops on `recv_from`. Each datagram goes to `parse_packet`. A bad packet is dropped and counted; to keep a noisy link from flooding stderr, it logs only the first drop and every 100th after that. For each good frame it emits the `telemetry://frame` Tauri event and offers the frame to the recorder. If the socket cannot bind (another instance, or a ground station already on the port), the listener logs one explanatory line and the app keeps running without telemetry.
- **`protocol.rs`** is a pure function layer with no I/O. See [section 3](#3-telemetry-wire-protocol) and [section 4](#4-coordinate-frames-and-attitude-mathematics).
- **`recorder.rs`** owns persistence. `udp.rs` calls `try_send` on a bounded `mpsc` channel (capacity 1024), so a stalled disk costs log frames, never real-time ingestion. The writer task waits for the first frame before creating `app_data_dir()/flights/flight_<unix-seconds>.jsonl`, so launching the app and closing it again leaves no empty files. It writes one JSON object per line through a `BufWriter` and flushes every 50 frames and at shutdown. It also exposes the `list_flight_logs` and `load_flight_log` IPC commands; `load_flight_log` accepts bare `.jsonl` file names only, so a name containing a path separator or `..` cannot escape the `flights/` directory.
- **`terrain.rs`** exposes `get_terrain_tile(z, x, y)`. It validates `z <= 15` and `x, y < 2^z`, serves the PNG from `app_data_dir()/tiles/{z}/{x}/{y}.png` when a non-empty file exists, and otherwise downloads it with `reqwest` (rustls, no system OpenSSL), checks for HTTP 200, and writes it through a `.tmp` file plus `rename`. The command returns raw PNG bytes; decoding happens in the WebView (see [section 2](#why-terrarium-dem--fwidth-contours)).

### Frontend (`src/`)

- **`routes/+page.svelte`** wires everything together. It listens for `telemetry://frame` (only when `__TAURI_INTERNALS__` exists, so `npm run dev` in a plain browser works), runs each frame through `TelemetryStats`, and hands the resolved frame to the scene. While a replay is active, live frames are ignored. The HUD snapshot refreshes on a 15 Hz timer, independent of the render loop.
- **`lib/telemetryStats.ts`** derives what the engine and HUD need from the frame stream: the AGL baseline (first frame's altitude), peak apogee, smoothed 3D speed, smoothed vertical speed (`dz/dt`), packet rate, Euler angles for display, and an inferred `IDLE`/`FLIGHT` phase when the sender gave none.
- **`engine/`** contains only TypeScript and `three`: no Svelte, no DOM UI, no Tauri imports. `FlightScene` takes a container element and an optional `tileFetcher` callback, which is how the Tauri tile command reaches the engine without the engine importing `@tauri-apps/api`.
- The render loop (`requestAnimationFrame`, display refresh rate, typically 60 FPS) is separate from the 15 Hz HUD refresh and from the telemetry rate.

---

## 2. Architectural decisions and trade-offs

### Why Tauri v2 instead of Electron

The backend work is socket I/O and file I/O. In Tauri that is native Rust (`tokio`) in the same process as the window, with no bundled Node.js runtime and no second language for the hot path. The WebView is the system one, so the binary does not ship a browser engine. The IPC boundary is explicit: typed commands (`list_flight_logs`, `load_flight_log`, `get_terrain_tile`) and one event (`telemetry://frame`), which keeps the engine testable without the backend.

The cost is that rendering depends on the platform WebView (WebView2, WKWebView, WebKitGTK), so WebGL behavior can differ slightly between operating systems. The shader is plain GLSL through Three's `ShaderMaterial` and uses only `fwidth`, which is core in WebGL2.

### Why a UDP loopback socket (`127.0.0.1:5005`)

Radio and serial hardware varies (LoRa modules, XBee, USB serial, MAVLink bridges), and every one of them ships with its own driver and tooling. Apogee View does not link any of that. Anything that can write a UDP datagram to loopback can feed it: a ground-station script in any language, a serial-to-UDP bridge, or `examples/mock_flight.py`. UDP also fits the data: telemetry is a stream of independent samples where the newest frame matters more than a retransmitted old one. Binding to loopback only means the port is not exposed to the network.

The trade-off is that UDP gives no delivery guarantee and the app has no authentication. On loopback, loss is not a practical concern; the datagram size limit (2048 bytes) is far above the 42-byte binary or typical JSON frame.

### Why append-only `.jsonl` blackbox logs

- **Crash behavior.** Frames are appended as complete lines, so a killed process leaves a valid file ending at the last flushed line. The writer flushes every 50 frames, which bounds the loss on a process crash to 50 frames. Note that `flush` hands data to the operating system; the recorder does not call `fsync`. A hard power cut can therefore lose more than 50 frames, depending on the OS write-back cache. If that matters for your use, add periodic `sync_data`.
- **Inspectability.** A log can be read with `less`, `jq`, or a notebook, with no tooling.
- **Replay.** One line is one frame, so loading a log is a line split, and scrubbing the timeline is an array index. `ReplayBar.svelte` loads the whole log, derives per-frame elapsed time from `ts`, and plays or seeks by index.

Logs store the normalized frame as emitted to the UI (unit quaternion, `state` as received). A binary stream is therefore logged with `state: "UNKNOWN"`, and the phase is inferred again on replay.

### Why Terrarium DEM tiles and `fwidth()` contours

Elevation comes from AWS Terrarium PNG tiles at zoom 13. Each pixel encodes elevation in meters as `(R * 256 + G + B / 256) - 32768`. The tiles are cached on disk by the Rust command, so a field laptop that loaded a launch site once can render it with no network. If the network is down and the tile is not cached, the terrain stays flat at 0 m and nothing else is affected.

Decoding happens in the WebView, not in Rust: the frontend turns the PNG bytes into pixels with `createImageBitmap` (color-space conversion disabled, since the channels are data, not color) and an `OffscreenCanvas`. That keeps the Rust side free of an image-decoding dependency; the cost is that the decode and pixel readback run in the WebView, once per launch-site load (nine 256x256 tiles).

Contour lines are computed in the fragment shader (`TopoContourMaterial.ts`), not baked into a texture or built as geometry. For a contour interval `I` and world height `h`, the shader computes `f = h / I`, the distance to the nearest integer in pixel units as `abs(fract(f - 0.5) - 0.5) / fwidth(f)`, and anti-aliases it with `smoothstep`. `fwidth(f)` is how many contour intervals one screen pixel spans, so line width stays constant in pixels at any zoom or viewing angle, and lines fade out where they would otherwise collapse into moire. It draws 10 m minor and 50 m major lines. The mesh is a 4000 m x 4000 m grid at 160 x 160 segments (25 m vertex spacing), which is plenty because the lines come from the interpolated height, not from the vertices.

---

## 3. Telemetry wire protocol

`parse_packet` looks at the first byte: `{` (`0x7B`) selects JSON, the two-byte header `0xAA 0x55` selects binary, anything else is rejected as an unknown header, and an empty datagram is rejected as empty.

### Binary frame (42 bytes, little-endian)

Layout, equivalent to the struct format `<2sI4fddf`:

| Offset | Size | Type        | Field                                  |
|-------:|-----:|-------------|----------------------------------------|
| 0      | 2    | `[u8; 2]`   | magic, `0xAA 0x55`                     |
| 2      | 4    | `u32`       | `ts`, flight-computer timestamp (ms)   |
| 6      | 16   | `[f32; 4]`  | quaternion `[w, x, y, z]` (NED/body)   |
| 22     | 8    | `f64`       | `lat`, degrees                         |
| 30     | 8    | `f64`       | `lon`, degrees                         |
| 38     | 4    | `f32`       | `alt`, meters MSL                      |

The packet must be exactly 42 bytes; shorter and longer packets return `BadLength`. The Rust struct is `#[repr(C, packed)]` because the first `f64` sits at offset 22, which natural alignment would pad. Fields are copied out of the packed struct before use, since taking a reference to a packed field is undefined behavior, and each value is converted from little-endian explicitly so the decode is correct on any host.

**There is no flight-state byte.** The 42-byte layout is fixed so that existing senders keep working, and the decoder labels every binary frame `state = "UNKNOWN"`. The frontend recovers a coarse phase instead (`TelemetryStats`, only when `state === "UNKNOWN"`):

- It starts in `IDLE`.
- `IDLE` becomes `FLIGHT` when AGL exceeds 2.0 m or the smoothed vertical speed reaches 1.5 m/s in magnitude.
- `FLIGHT` returns to `IDLE` once AGL is below 2.0 m and the vertical speed is below 0.5 m/s, held continuously for 1 s of frame time.

`IDLE` and `FLIGHT` have their own trail and badge colors, so a binary stream visibly changes color at liftoff and touchdown. Frames from a sender that does provide a state pass through unchanged.

### JSON frame

```json
{
  "ts": 123456,
  "quat": [0.9239, 0.0, 0.3827, 0.0],
  "euler": [0.0, 45.0, 0.0],
  "gps": { "lat": 39.9334, "lon": 32.8597, "alt": 851.2 },
  "baro_alt": 851.9,
  "state": "COAST"
}
```

| Field      | Type            | Required | Notes                                                               |
|------------|-----------------|----------|---------------------------------------------------------------------|
| `ts`       | `u32`           | yes      | milliseconds (the backend does not interpret it; the frontend assumes ms) |
| `quat`     | `[f32; 4]`      | one of   | `[w, x, y, z]`; normalized on input; a zero quaternion is rejected  |
| `euler`    | `[f32; 3]`      | one of   | `[roll, pitch, yaw]` in degrees, ZYX order; used only if `quat` is absent |
| `gps`      | `{lat, lon, alt}` | yes    | degrees, degrees, meters                                            |
| `baro_alt` | `f32`           | no       | preferred over `gps.alt` when present                               |
| `state`    | string          | no       | defaults to `"UNKNOWN"`                                             |

A frame with neither `quat` nor `euler` is rejected (`MissingAttitude`). Recognized phases, which the trail and HUD color-code, are `PAD_IDLE`, `BOOST`, `COAST`, `APOGEE`, `DROGUE`, `MAIN`, and `LANDED`. Other strings are accepted and drawn with a neutral fallback color.

### Validation (both formats)

Every frame passes through `build_frame`, which rejects non-finite values with a named error: `NaN` or infinity in any quaternion component, in `lat` or `lon`, or in `alt`. JSON numbers that overflow `f32` (for example `1e39`) become infinity on conversion and are rejected by the same check, and the Euler path checks finiteness before converting. After validation, the quaternion is normalized to unit length. Nothing in this layer panics on malformed input; the tests in `protocol.rs` cover truncation, bad magic, invalid JSON, overflowing numbers, and the pitch = +/-90 degree cases.

The Rust side never interprets `ts`. The frontend does: speed and vertical speed divide by the `ts` difference and assume it is in milliseconds.

---

## 4. Coordinate frames and attitude mathematics

### The three frames

```
  NED (aerospace)           ENU (geographic tangent)       Three.js world
  +X North                  +X East                        +X East
  +Y East                   +Y North                       +Y Up
  +Z Down                   +Z Up                          -Z North
                                                           (right-handed, Y-up)

  Top-down view (looking at the ground), each frame's horizontal axes:

        N (+X)                    N (+Y)                       N (-Z)
        ^                         ^                            ^
        |                         |                            |
        +----> E (+Y)             +----> E (+X)                 +----> E (+X)

  Vertical axis: NED +Z points into the ground, ENU +Z and Three.js +Y point up.
```

NED is what flight software emits, and its quaternions are the input. ENU is the usual geographic tangent frame. Three.js uses a Y-up world, so the engine uses ENU with the axes relabeled: East stays `+X`, Up becomes `+Y`, and North becomes `-Z` (so that the basis stays right-handed). A point given in NED `(n, e, d)` lands at Three.js `(e, -d, -n)`.

### Position: `OriginProjector` (WGS84 local tangent plane)

The first frame with finite latitude, longitude, and altitude locks the launch origin `(lat0, lon0, alt0)`. Until then `project()` returns `null`. `resetOrigin()` unlocks it, and the next valid fix becomes the new origin. For later fixes, with `phi0 = lat0`:

```
W   = sqrt(1 - e^2 * sin^2(phi0))          e^2 = 0.00669437999014 (WGS84)
Rm  = a * (1 - e^2) / W^3                  meridian radius of curvature
Rn  = a / W                                prime-vertical radius of curvature
                                           a = 6378137 m

north = (lat - lat0) * Rm * pi/180         meters per degree of latitude  = Rm * pi/180
east  = (lon - lon0) * Rn * cos(phi0) * pi/180
up    = alt - alt0

three.x =  east
three.y =  up
three.z = -north
```

The scale factors are computed once at the origin (`metersPerDegree(lat0)`), so projecting a fix is two multiplications and a subtraction. This is a local linearization: it is accurate over the few kilometers of a rocket flight, and not meant for long baselines. The same `metersPerDegree` function also drives the terrain vertices and the speed estimate, so everything shares one scale.

### Attitude: quaternion conventions

Quaternions are `[w, x, y, z]`, body-to-NED. Euler angles use the aerospace ZYX intrinsic convention: yaw about Z (down), then pitch about the new Y, then roll about the new X, so the rotation is `R = Rz(yaw) * Ry(pitch) * Rx(roll)`. `euler_to_quat` in `protocol.rs` (degrees in, `[w, x, y, z]` out), with `s`/`c` the sine and cosine of half-angles:

```
w = cr*cp*cy + sr*sp*sy
x = sr*cp*cy - cr*sp*sy
y = cr*sp*cy + sr*cp*sy
z = cr*cp*sy - sr*sp*cy
```

**NED to Three.js.** The change of basis from NED to Three.js is the axis permutation `M`: `(n, e, d) -> (e, -d, -n)`. It is a proper rotation (determinant +1). A quaternion's vector part `(x, y, z)` transforms like a vector, and the scalar part `w` does not change, so:

```
nedQuatToThree([w, x, y, z]) = Quaternion(x = y, y = -z, z = -x, w = w)   // then normalized
```

An NED identity quaternion maps to the Three.js identity. A NED yaw of +90 degrees (about Down) swings North to East; in Three.js that is `-Z` to `+X`. The unit tests check exactly these cases, plus an arbitrary attitude against a direct NED rotation.

**Euler recovery for the HUD** (`eulerFromNedQuat`, inverse of the formula above, in double precision):

```
roll  = atan2(2(wx + yz), 1 - 2(x^2 + y^2))
pitch = asin(clamp(2(wy - zx), -1, 1))
yaw   = atan2(2(wz + xy), 1 - 2(y^2 + z^2))      reported as 0..360 degrees
```

**Gimbal lock.** At `pitch = +/-90` degrees, roll and yaw are no longer independent; only their combination survives (`roll - yaw` at +90, `roll + yaw` at -90). Two things follow:

- Rust: `euler_to_quat` has no singularity. It stays finite with unit norm at +/-90 degrees, and the tests check the exact component values in terms of the combined angle.
- Display: `eulerFromNedQuat` clamps the `asin` argument, so pitch comes back as exactly +/-90 with no `NaN`. `atan2(0, 0)` makes roll and yaw read 0 at the exact singularity. Near it (for example 89.9 degrees) the round trip recovers all three angles to within 1e-4 degrees. The rocket model is driven by the quaternion, not by Euler angles, so rendering is unaffected.

The model itself is built nose-up along its local `+Y`, inside a child group rotated -90 degrees about X so that nose points along `-Z` (North) at identity attitude. With this, NED pitch +90 degrees stands the rocket vertical on the pad.

---

## 5. Rendering and GPU synchronization

These invariants were each fixed after a visible bug. Change them carefully.

### Damping versus snapping

The render loop moves the displayed pose toward the latest telemetry target with exponential smoothing, so 20-100 Hz data renders without stair-stepping:

```
alpha = 1 - exp(-k * dt)        k = 12 /s (position), 14 /s (attitude); dt clamped to 0.1 s
position.lerp(target, alpha);   quaternion.slerp(targetQuat, alpha)
```

This is wrong whenever the target jumps: replay scrubbing, replay start, `resetOrigin`. A jump damped over several frames makes the rocket fly across the scene, and anything sampling the rendered position (the trail) draws that flight as a chord. `FlightScene` therefore has a rebuild state. `clearTrail()` and `resetOrigin()` empty the trail and set it, `snapToTarget()` sets it without emptying the trail. While it is set, frames pushed in a burst are appended straight to the trail at their raw positions, so the history up to the playhead stays contiguous. On the next render, the first one after a frame arrived, the displayed pose is copied from the target with no damping, the state clears, and normal smoothing resumes. Nothing is added to the trail until a frame has actually been pushed, so a pre-replay pose such as the pad rest position never leaks into it. `ReplayBar` marks scrubs and the initial open as seeks; ordinary playback stepping is not, so it keeps smoothing and contiguous trail growth.

In normal flight the trail samples the rendered (damped) position, so it ends at the airframe's center of gravity and never runs ahead of the nose.

### Terrain floor and landing attitude

The target height is clamped against the terrain under the rocket:

```
upright   = | world-y of the nose axis |           1 standing, 0 lying down
clearance = 0.08 + (REST_HEIGHT - 0.08) * upright    REST_HEIGHT = half the airframe length
y         = max(projected_up, terrain.sampleHeight(x, z)) + clearance
```

`sampleHeight(x, z)` bilinearly interpolates the CPU-side elevation grid (the same 161 x 161 grid used to displace the mesh), so the drop-line, its nadir marker, the 50 m scale ring, and this clamp all agree with the drawn surface. The clearance interpolation matters because the rocket pivots on its center of gravity: a standing rocket needs about 0.8 m under the CG, a lying one only its body radius. The nose axis is the mesh's `-Z` (not its local `+Y`, which is rotated away), so the uprightness is measured on the correct axis. DEM data is relative to the elevation at the launch origin, so the pad sits at `y = 0`. While the DEM is loading, or if it fails to load, the sampler returns 0.

### Trail buffer and the GPU dirty range

`FlightTrail` pre-allocates a 20,000-vertex position buffer and color buffer once and draws them with `setDrawRange(0, count)`; nothing is reallocated while telemetry streams in. A point is appended when the position moves more than 0.05 m from the last one, or when the phase changes. When the buffer fills, the oldest half is shifted out.

The part that is easy to get wrong is telling Three.js which part of the buffers changed. A dirty range has to be set in `push()`, at the moment the data is written, and it has to cover everything written since the last render:

```
push():           write vertex i; dirtyFrom = min(dirtyFrom, i);
                  set update range [dirtyFrom, count) on position and color attributes
onBeforeRender(): dirtyFrom = count          // the upload for this frame has already happened
```

Two earlier designs failed in visible ways:

1. **One-vertex range per push.** A replay seek writes thousands of vertices between two renders, but each push replaced the previous range with a range for its own single vertex. Only the last vertex reached the GPU; the rest of the draw range showed stale vertices from earlier passes, which stacked old trajectories on screen when scrubbing.
2. **Computing the range inside `onBeforeRender`.** Three.js uploads attribute changes while it builds the render list, which is before `onBeforeRender` runs for the object. A range scheduled in that hook is therefore uploaded one render late, so the newest vertex was never on the GPU when it was drawn. An unwritten GPU slot reads as `(0, 0, 0)`, which drew a line from the end of the trail down to the launch pad on every frame.

The current design keeps the range correct at write time. `onBeforeRender` is used only to record that the previous range has been consumed. `clear()` resets the count, the dirty index, and the draw range together.

---

## 6. Known limits

- **Phase inference noise.** The `IDLE`/`FLIGHT` thresholds are fixed. Raw altitude noise of a few tenths of a meter at 50 Hz looks like several m/s of vertical speed and can trigger `FLIGHT` on the pad. If it does, add a deadband or a longer smoothing window.
- **Landing above the launch altitude.** The return to `IDLE` needs AGL under 2 m. Landing on ground more than 2 m above the launch point never returns to `IDLE`.
- **`ts` units.** Speed math assumes `ts` is in milliseconds. Another unit scales speed and vertical speed.
- **Trail length.** 20,000 vertices; beyond that the oldest half is dropped.
- **Terrain extent.** 4 km x 4 km around the launch origin, fading into the background at the edge. Zoom-13 Terrarium tiles are roughly 15-19 m per pixel at mid latitudes, so fine relief is smoothed.
- **Terrain relief and the flat default.** There is no DEM until the first fix locks the origin and the tiles load. The scene is flat at 0 m before that and whenever tiles are unavailable and uncached.
- **Log durability.** See [section 2](#why-append-only-jsonl-blackbox-logs): flushed lines survive a process crash, but the recorder does not `fsync`.
- **Flat-earth projection.** Position math is a local linearization around the origin and is meant for kilometer-scale flights.
