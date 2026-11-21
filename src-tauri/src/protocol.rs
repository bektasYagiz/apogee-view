use bytemuck::{Pod, Zeroable};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const BINARY_HEADER: [u8; 2] = [0xAA, 0x55];
pub const BINARY_LEN: usize = 42;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TelemetryFrame {
    pub ts: u32,
    pub quat: [f32; 4],
    pub lat: f64,
    pub lon: f64,
    pub alt: f32,
    pub state: String,
}

#[derive(Debug, PartialEq)]
pub enum ProtocolError {
    Empty,
    UnknownHeader(u8),
    BadLength { expected: usize, got: usize },
    BadJson(String),
    MissingAttitude,
    NonFinite(&'static str),
    ZeroQuaternion,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "empty payload"),
            Self::UnknownHeader(b) => write!(f, "unrecognized first byte 0x{b:02X}"),
            Self::BadLength { expected, got } => {
                write!(f, "binary packet must be {expected} bytes, got {got}")
            }
            Self::BadJson(e) => write!(f, "malformed json: {e}"),
            Self::MissingAttitude => write!(f, "neither quat nor euler present"),
            Self::NonFinite(field) => write!(f, "non-finite value in {field}"),
            Self::ZeroQuaternion => write!(f, "quaternion has zero length"),
        }
    }
}

impl std::error::Error for ProtocolError {}

// Packed on purpose: wire layout puts an f64 at offset 22, so natural alignment would add padding.
#[repr(C, packed)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct RawBinary {
    header: [u8; 2],
    ts: u32,
    quat: [f32; 4],
    lat: f64,
    lon: f64,
    alt: f32,
}

#[derive(Deserialize)]
struct RawGps {
    lat: f64,
    lon: f64,
    alt: f32,
}

#[derive(Deserialize)]
struct RawJson {
    ts: u32,
    quat: Option<[f32; 4]>,
    euler: Option<[f32; 3]>,
    gps: RawGps,
    baro_alt: Option<f32>,
    state: Option<String>,
}

pub fn parse_packet(raw: &[u8]) -> Result<TelemetryFrame, ProtocolError> {
    match raw {
        [] => Err(ProtocolError::Empty),
        [0x7B, ..] => parse_json(raw),
        [0xAA, 0x55, ..] => parse_binary(raw),
        [b, ..] => Err(ProtocolError::UnknownHeader(*b)),
    }
}

fn parse_json(raw: &[u8]) -> Result<TelemetryFrame, ProtocolError> {
    let p: RawJson =
        serde_json::from_slice(raw).map_err(|e| ProtocolError::BadJson(e.to_string()))?;

    let quat = match (p.quat, p.euler) {
        (Some(q), _) => q,
        (None, Some(e)) => {
            finite(&e, "euler")?;
            euler_to_quat(e)
        }
        (None, None) => return Err(ProtocolError::MissingAttitude),
    };

    build_frame(
        p.ts,
        quat,
        p.gps.lat,
        p.gps.lon,
        p.baro_alt.unwrap_or(p.gps.alt),
        p.state.unwrap_or_else(|| "UNKNOWN".to_owned()),
    )
}

fn parse_binary(raw: &[u8]) -> Result<TelemetryFrame, ProtocolError> {
    if raw.len() != BINARY_LEN {
        return Err(ProtocolError::BadLength {
            expected: BINARY_LEN,
            got: raw.len(),
        });
    }
    let r: RawBinary = bytemuck::pod_read_unaligned(raw);
    // Copy fields out of the packed struct; references to packed fields are UB.
    let (ts, quat, lat, lon, alt) = (r.ts, r.quat, r.lat, r.lon, r.alt);
    build_frame(
        u32::from_le(ts),
        quat.map(|v| f32::from_bits(u32::from_le(v.to_bits()))),
        f64::from_bits(u64::from_le(lat.to_bits())),
        f64::from_bits(u64::from_le(lon.to_bits())),
        f32::from_bits(u32::from_le(alt.to_bits())),
        "UNKNOWN".to_owned(),
    )
}

fn build_frame(
    ts: u32,
    quat: [f32; 4],
    lat: f64,
    lon: f64,
    alt: f32,
    state: String,
) -> Result<TelemetryFrame, ProtocolError> {
    finite(&quat, "quat")?;
    if !lat.is_finite() || !lon.is_finite() {
        return Err(ProtocolError::NonFinite("position"));
    }
    if !alt.is_finite() {
        return Err(ProtocolError::NonFinite("alt"));
    }
    Ok(TelemetryFrame {
        ts,
        quat: normalize(quat)?,
        lat,
        lon,
        alt,
        state,
    })
}

fn finite(v: &[f32], field: &'static str) -> Result<(), ProtocolError> {
    if v.iter().all(|x| x.is_finite()) {
        Ok(())
    } else {
        Err(ProtocolError::NonFinite(field))
    }
}

fn normalize(q: [f32; 4]) -> Result<[f32; 4], ProtocolError> {
    let n = q.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n < f32::EPSILON {
        return Err(ProtocolError::ZeroQuaternion);
    }
    Ok(q.map(|x| x / n))
}

// Aerospace ZYX (yaw, pitch, roll) intrinsic order; input in degrees, output [w, x, y, z].
fn euler_to_quat([roll, pitch, yaw]: [f32; 3]) -> [f32; 4] {
    let (sr, cr) = (roll.to_radians() * 0.5).sin_cos();
    let (sp, cp) = (pitch.to_radians() * 0.5).sin_cos();
    let (sy, cy) = (yaw.to_radians() * 0.5).sin_cos();
    [
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-5;

    fn close(a: [f32; 4], b: [f32; 4]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < EPS)
    }

    fn binary_packet(quat: [f32; 4]) -> Vec<u8> {
        binary_with(quat, 39.9334, 32.8597, 850.5)
    }

    fn binary_with(quat: [f32; 4], lat: f64, lon: f64, alt: f32) -> Vec<u8> {
        let mut v = BINARY_HEADER.to_vec();
        v.extend_from_slice(&1234u32.to_le_bytes());
        for q in quat {
            v.extend_from_slice(&q.to_le_bytes());
        }
        v.extend_from_slice(&lat.to_le_bytes());
        v.extend_from_slice(&lon.to_le_bytes());
        v.extend_from_slice(&alt.to_le_bytes());
        v
    }

    fn unit_norm(q: [f32; 4]) -> f32 {
        q.iter().map(|x| x * x).sum::<f32>().sqrt()
    }

    #[test]
    fn json_quat_normalized_and_baro_preferred() {
        let raw = br#"{"ts":100,"quat":[2,0,0,0],"gps":{"lat":1.5,"lon":2.5,"alt":10.0},"baro_alt":12.0,"state":"BOOST"}"#;
        let f = parse_packet(raw).unwrap();
        assert_eq!(f.ts, 100);
        assert!(close(f.quat, [1.0, 0.0, 0.0, 0.0]));
        assert_eq!((f.lat, f.lon), (1.5, 2.5));
        assert_eq!(f.alt, 12.0);
        assert_eq!(f.state, "BOOST");
    }

    #[test]
    fn json_falls_back_to_gps_alt_and_unknown_state() {
        let raw = br#"{"ts":1,"quat":[1,0,0,0],"gps":{"lat":0,"lon":0,"alt":10.0}}"#;
        let f = parse_packet(raw).unwrap();
        assert_eq!(f.alt, 10.0);
        assert_eq!(f.state, "UNKNOWN");
    }

    #[test]
    fn json_euler_pitch_90() {
        let raw = br#"{"ts":1,"euler":[0.0,90.0,0.0],"gps":{"lat":0,"lon":0,"alt":0}}"#;
        let f = parse_packet(raw).unwrap();
        let h = std::f32::consts::FRAC_1_SQRT_2;
        assert!(close(f.quat, [h, 0.0, h, 0.0]));
    }

    #[test]
    fn json_euler_yaw_90() {
        let raw = br#"{"ts":1,"euler":[0.0,0.0,90.0],"gps":{"lat":0,"lon":0,"alt":0}}"#;
        let h = std::f32::consts::FRAC_1_SQRT_2;
        assert!(close(parse_packet(raw).unwrap().quat, [h, 0.0, 0.0, h]));
    }

    #[test]
    fn binary_roundtrip() {
        let f = parse_packet(&binary_packet([1.0, 0.0, 0.0, 0.0])).unwrap();
        assert_eq!(f.ts, 1234);
        assert!(close(f.quat, [1.0, 0.0, 0.0, 0.0]));
        assert_eq!(f.lat, 39.9334);
        assert_eq!(f.lon, 32.8597);
        assert_eq!(f.alt, 850.5);
        assert_eq!(f.state, "UNKNOWN");
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(parse_packet(&[]), Err(ProtocolError::Empty));
        assert_eq!(parse_packet(&[0x01, 0x02]), Err(ProtocolError::UnknownHeader(1)));
        assert_eq!(parse_packet(&[0xAA, 0x00, 0, 0]), Err(ProtocolError::UnknownHeader(0xAA)));

        let short = binary_packet([1.0, 0.0, 0.0, 0.0]);
        assert!(matches!(
            parse_packet(&short[..41]),
            Err(ProtocolError::BadLength { expected: 42, got: 41 })
        ));

        assert!(matches!(parse_packet(b"{not json"), Err(ProtocolError::BadJson(_))));
        assert_eq!(
            parse_packet(br#"{"ts":1,"gps":{"lat":0,"lon":0,"alt":0}}"#),
            Err(ProtocolError::MissingAttitude)
        );

        assert_eq!(
            parse_packet(&binary_packet([f32::NAN, 0.0, 0.0, 0.0])),
            Err(ProtocolError::NonFinite("quat"))
        );
        assert_eq!(
            parse_packet(&binary_packet([0.0; 4])),
            Err(ProtocolError::ZeroQuaternion)
        );
    }

    #[test]
    fn malformed_binary_never_panics() {
        let good = binary_packet([1.0, 0.0, 0.0, 0.0]);

        let mut bad_magic = good.clone();
        bad_magic[1] = 0x56;
        assert_eq!(parse_packet(&bad_magic), Err(ProtocolError::UnknownHeader(0xAA)));
        assert_eq!(parse_packet(&[0xAA]), Err(ProtocolError::UnknownHeader(0xAA)));
        assert_eq!(parse_packet(&[0x55, 0xAA]), Err(ProtocolError::UnknownHeader(0x55)));

        let mut long = good.clone();
        long.push(0);
        assert!(matches!(
            parse_packet(&long),
            Err(ProtocolError::BadLength { expected: 42, got: 43 })
        ));

        // header-only up to one byte short: every truncation is a clean error
        for n in 2..BINARY_LEN {
            assert!(
                matches!(parse_packet(&good[..n]), Err(ProtocolError::BadLength { .. })),
                "len {n}"
            );
        }
    }

    #[test]
    fn malformed_json_never_panics() {
        let good = br#"{"ts":1,"quat":[1,0,0,0],"gps":{"lat":0,"lon":0,"alt":1.0}}"#;
        assert!(parse_packet(good).is_ok());

        // a strict prefix of a JSON object is never valid
        for n in 1..good.len() {
            assert!(matches!(parse_packet(&good[..n]), Err(ProtocolError::BadJson(_))), "len {n}");
        }

        for bad in [
            &br#"{"ts":1,"quat":[1,0,0,0]}"#[..],
            br#"{"ts":"x","quat":[1,0,0,0],"gps":{"lat":0,"lon":0,"alt":0}}"#,
            br#"{"ts":-1,"quat":[1,0,0,0],"gps":{"lat":0,"lon":0,"alt":0}}"#,
            br#"{"ts":1,"quat":[1,0,0],"gps":{"lat":0,"lon":0,"alt":0}}"#,
            br#"{"ts":1,"quat":[1,0,0,0],"gps":{"lat":null,"lon":0,"alt":0}}"#,
            br#"{"ts":1,"quat":[NaN,0,0,0],"gps":{"lat":0,"lon":0,"alt":0}}"#,
            b"{}",
            &[0x7B, 0xFF, 0xFE],
        ] {
            assert!(matches!(parse_packet(bad), Err(ProtocolError::BadJson(_))));
        }
    }

    #[test]
    fn binary_non_finite_fields_are_rejected() {
        let id = [1.0, 0.0, 0.0, 0.0];
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            for i in 0..4 {
                let mut q = id;
                q[i] = bad;
                assert_eq!(parse_packet(&binary_with(q, 1.0, 1.0, 1.0)), Err(ProtocolError::NonFinite("quat")));
            }
            assert_eq!(parse_packet(&binary_with(id, 1.0, 1.0, bad)), Err(ProtocolError::NonFinite("alt")));
        }
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(parse_packet(&binary_with(id, bad, 1.0, 1.0)), Err(ProtocolError::NonFinite("position")));
            assert_eq!(parse_packet(&binary_with(id, 1.0, bad, 1.0)), Err(ProtocolError::NonFinite("position")));
        }
    }

    #[test]
    fn json_overflowing_numbers_are_rejected() {
        // 1e39 fits f64 but overflows f32 to infinity
        for raw in [
            &br#"{"ts":1,"quat":[1e39,0,0,0],"gps":{"lat":0,"lon":0,"alt":0}}"#[..],
            br#"{"ts":1,"quat":[1,0,0,0],"gps":{"lat":0,"lon":0,"alt":1e39}}"#,
            br#"{"ts":1,"quat":[1,0,0,0],"gps":{"lat":0,"lon":0,"alt":0},"baro_alt":-1e39}"#,
            br#"{"ts":1,"euler":[0,1e39,0],"gps":{"lat":0,"lon":0,"alt":0}}"#,
            br#"{"ts":1,"quat":[1,0,0,0],"gps":{"lat":1e999,"lon":0,"alt":0}}"#,
        ] {
            assert!(parse_packet(raw).is_err(), "{}", String::from_utf8_lossy(raw));
        }
    }

    #[test]
    fn gimbal_lock_pitch_90_is_unit_and_exact() {
        let h = std::f32::consts::FRAC_1_SQRT_2;
        // at +90 pitch roll and yaw collapse to one angle, (roll - yaw); expect w=y=h*cos(d/2), x=-z=h*sin(d/2)
        for (roll, yaw) in [(0.0, 0.0), (30.0, 0.0), (0.0, 30.0), (45.0, 45.0), (170.0, -20.0)] {
            let q = euler_to_quat([roll, 90.0, yaw]);
            let half = (roll - yaw).to_radians() * 0.5;
            assert!(q.iter().all(|v| v.is_finite()));
            assert!((unit_norm(q) - 1.0).abs() < EPS, "norm {}", unit_norm(q));
            assert!(close(q, [h * half.cos(), h * half.sin(), h * half.cos(), -h * half.sin()]), "{q:?}");
        }
        assert!(close(euler_to_quat([0.0, 90.0, 0.0]), [h, 0.0, h, 0.0]));
    }

    #[test]
    fn gimbal_lock_pitch_minus_90_is_unit_and_exact() {
        let h = std::f32::consts::FRAC_1_SQRT_2;
        // at -90 pitch the surviving angle is (roll + yaw); expect w=-y=h*cos(s/2), x=z=h*sin(s/2)
        for (roll, yaw) in [(0.0, 0.0), (30.0, 0.0), (0.0, 30.0), (45.0, 45.0), (170.0, -20.0)] {
            let q = euler_to_quat([roll, -90.0, yaw]);
            let half = (roll + yaw).to_radians() * 0.5;
            assert!(q.iter().all(|v| v.is_finite()));
            assert!((unit_norm(q) - 1.0).abs() < EPS, "norm {}", unit_norm(q));
            assert!(close(q, [h * half.cos(), h * half.sin(), -h * half.cos(), h * half.sin()]), "{q:?}");
        }
        assert!(close(euler_to_quat([0.0, -90.0, 0.0]), [h, 0.0, -h, 0.0]));
    }

    #[test]
    fn gimbal_lock_through_json_stays_finite_and_normalized() {
        for pitch in ["90.0", "-90.0", "90.000001", "-90.000001"] {
            let raw = format!(
                r#"{{"ts":1,"euler":[10.0,{pitch},20.0],"gps":{{"lat":0,"lon":0,"alt":0}}}}"#
            );
            let q = parse_packet(raw.as_bytes()).unwrap().quat;
            assert!(q.iter().all(|v| v.is_finite()), "{pitch}: {q:?}");
            assert!((unit_norm(q) - 1.0).abs() < EPS, "{pitch}");
        }
    }
}
