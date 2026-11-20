#!/usr/bin/env python3
import argparse
import json
import math
import socket
import struct
import time

ADDR = ("127.0.0.1", 5005)
BINARY_FMT = "<2sI4fddf"
HEADER = b"\xaa\x55"

PAD_LAT, PAD_LON, PAD_ALT = 39.9334, 32.8597, 850.0
M_PER_DEG = 111_320.0

IDLE_T, BOOST_T, COAST_T, APOGEE_T = 3.0, 4.0, 8.0, 1.0
BOOST_ACCEL = 60.0
COAST_DECEL = 30.0
DROGUE_SINK, MAIN_SINK = 25.0, 6.0
MAIN_DEPLOY_AGL = 300.0
WIND_E, WIND_N = 4.0, 1.0
LANDED_HOLD_T = 3.0


def euler_to_quat(roll, pitch, yaw):
    # ZYX aerospace order, degrees in, [w, x, y, z] out
    sr, cr = math.sin(math.radians(roll) / 2), math.cos(math.radians(roll) / 2)
    sp, cp = math.sin(math.radians(pitch) / 2), math.cos(math.radians(pitch) / 2)
    sy, cy = math.sin(math.radians(yaw) / 2), math.cos(math.radians(yaw) / 2)
    return (
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    )


class Flight:
    def __init__(self):
        self.t = 0.0
        self.agl = 0.0
        self.vz = 0.0
        self.east = 0.0
        self.north = 0.0
        self.roll = 0.0
        self.pitch = 90.0
        self.state = "PAD_IDLE"
        self.landed_at = None

    def step(self, dt):
        self.t += dt
        t = self.t
        boost_end = IDLE_T + BOOST_T
        coast_end = boost_end + COAST_T
        apogee_end = coast_end + APOGEE_T

        if t < IDLE_T:
            self.state = "PAD_IDLE"
        elif t < boost_end:
            self.state = "BOOST"
            self.vz += BOOST_ACCEL * dt
            self.roll += 90.0 * (1.0 - (t - IDLE_T) / BOOST_T) * dt
            self.pitch = 90.0 - 2.0 * (t - IDLE_T)
        elif t < coast_end:
            self.state = "COAST"
            self.vz = max(self.vz - COAST_DECEL * dt, 0.0)
            self.roll += 15.0 * dt
            self.pitch -= 1.5 * dt
        elif t < apogee_end:
            self.state = "APOGEE"
            self.vz = 0.0
            self.pitch = max(self.pitch - 60.0 * dt, -80.0)
        elif self.agl > 0.0:
            descending_fast = self.agl > MAIN_DEPLOY_AGL
            self.state = "DROGUE" if descending_fast else "MAIN"
            self.vz = -(DROGUE_SINK if descending_fast else MAIN_SINK)
            self.east += WIND_E * dt
            self.north += WIND_N * dt
            self.pitch = -80.0 if descending_fast else -88.0
            self.roll += 10.0 * dt
        else:
            self.state = "LANDED"
            self.vz = 0.0
            self.pitch = 5.0
            if self.landed_at is None:
                self.landed_at = t

        self.agl = max(self.agl + self.vz * dt, 0.0)

    def done(self):
        return self.landed_at is not None and self.t - self.landed_at >= LANDED_HOLD_T

    def sample(self):
        euler = (self.roll % 360.0, self.pitch, 0.0)
        lat = PAD_LAT + self.north / M_PER_DEG
        lon = PAD_LON + self.east / (M_PER_DEG * math.cos(math.radians(PAD_LAT)))
        return {
            "ts": int(self.t * 1000),
            "quat": euler_to_quat(*euler),
            "euler": euler,
            "lat": lat,
            "lon": lon,
            "alt": PAD_ALT + self.agl,
            "state": self.state,
        }


def encode_json(s):
    return json.dumps(
        {
            "ts": s["ts"],
            "quat": list(s["quat"]),
            "euler": list(s["euler"]),
            "gps": {"lat": s["lat"], "lon": s["lon"], "alt": s["alt"]},
            "baro_alt": s["alt"],
            "state": s["state"],
        }
    ).encode()


def encode_binary(s):
    return struct.pack(BINARY_FMT, HEADER, s["ts"], *s["quat"], s["lat"], s["lon"], s["alt"])


def main():
    ap = argparse.ArgumentParser(description="Fake rocket flight over UDP loopback.")
    ap.add_argument("--mode", choices=("json", "binary"), default="json")
    ap.add_argument("--rate", type=float, default=50.0, help="packets per second")
    args = ap.parse_args()
    if args.rate <= 0:
        ap.error("--rate must be positive")

    encode = encode_json if args.mode == "json" else encode_binary
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dt = 1.0 / args.rate
    flight = Flight()
    last_state = None
    next_tick = time.monotonic()

    print(f"sending {args.mode} @ {args.rate:g} Hz to {ADDR[0]}:{ADDR[1]}")
    while not flight.done():
        flight.step(dt)
        s = flight.sample()
        sock.sendto(encode(s), ADDR)
        if s["state"] != last_state:
            print(f"t={flight.t:6.2f}s  {s['state']:<9} agl={flight.agl:7.1f} m")
            last_state = s["state"]
        next_tick += dt
        time.sleep(max(next_tick - time.monotonic(), 0.0))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
