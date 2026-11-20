use crate::protocol::{TelemetryFrame, parse_packet};
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;

pub const BIND_ADDR: &str = "127.0.0.1:5005";
pub const FRAME_EVENT: &str = "telemetry://frame";
const MAX_DATAGRAM: usize = 2048;
const DROP_LOG_EVERY: u64 = 100;

pub async fn listen(app: AppHandle) {
    let socket = match UdpSocket::bind(BIND_ADDR).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "udp: can't bind {BIND_ADDR} ({e}). Another instance or ground station on the port? Telemetry is dead until it's freed."
            );
            return;
        }
    };
    recv_loop(socket, |frame| {
        if let Err(e) = app.emit(FRAME_EVENT, &frame) {
            eprintln!("udp: frame emit failed: {e}");
        }
    })
    .await;
}

async fn recv_loop(socket: UdpSocket, mut on_frame: impl FnMut(TelemetryFrame)) {
    let mut buf = [0u8; MAX_DATAGRAM];
    let mut dropped: u64 = 0;
    loop {
        let len = match socket.recv_from(&mut buf).await {
            Ok((len, _)) => len,
            Err(e) => {
                eprintln!("udp: recv error: {e}");
                continue;
            }
        };
        match parse_packet(&buf[..len]) {
            Ok(frame) => on_frame(frame),
            Err(e) => {
                dropped += 1;
                if dropped % DROP_LOG_EVERY == 1 {
                    eprintln!("udp: dropped bad packet ({e}); {dropped} dropped so far");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    #[tokio::test]
    async fn json_and_binary_reach_the_callback() {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = socket.local_addr().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        tokio::spawn(recv_loop(socket, move |f| {
            let _ = tx.send(f);
        }));

        let sender = UdpSocket::bind("127.0.0.1:0").await.unwrap();

        sender.send_to(b"garbage", addr).await.unwrap();
        sender
            .send_to(
                br#"{"ts":7,"quat":[1,0,0,0],"gps":{"lat":1.0,"lon":2.0,"alt":3.0},"state":"BOOST"}"#,
                addr,
            )
            .await
            .unwrap();

        let mut bin = vec![0xAA, 0x55];
        bin.extend_from_slice(&9u32.to_le_bytes());
        for q in [1.0f32, 0.0, 0.0, 0.0] {
            bin.extend_from_slice(&q.to_le_bytes());
        }
        bin.extend_from_slice(&10.0f64.to_le_bytes());
        bin.extend_from_slice(&20.0f64.to_le_bytes());
        bin.extend_from_slice(&30.0f32.to_le_bytes());
        sender.send_to(&bin, addr).await.unwrap();

        let wait = Duration::from_secs(2);
        let a = timeout(wait, rx.recv()).await.unwrap().unwrap();
        let b = timeout(wait, rx.recv()).await.unwrap().unwrap();
        assert_eq!((a.ts, a.state.as_str()), (7, "BOOST"));
        assert_eq!((b.ts, b.lat, b.lon, b.alt), (9, 10.0, 20.0, 30.0));
    }
}
