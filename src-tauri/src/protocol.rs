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
        let mut v = BINARY_HEADER.to_vec();
        v.extend_from_slice(&1234u32.to_le_bytes());
        for q in quat {
            v.extend_from_slice(&q.to_le_bytes());
        }
        v.extend_from_slice(&39.9334f64.to_le_bytes());
        v.extend_from_slice(&32.8597f64.to_le_bytes());
        v.extend_from_slice(&850.5f32.to_le_bytes());
        v
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
}
