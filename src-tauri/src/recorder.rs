use crate::protocol::TelemetryFrame;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::fs::{self, File};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::mpsc;

const CHANNEL_CAP: usize = 1024;
const FLUSH_EVERY: u32 = 50;
const LOG_EXT: &str = "jsonl";

// TelemetryFrame is serialize-only; this mirrors it for reading logs back.
#[derive(Deserialize)]
struct LoggedFrame {
    ts: u32,
    quat: [f32; 4],
    lat: f64,
    lon: f64,
    alt: f32,
    state: String,
}

impl From<LoggedFrame> for TelemetryFrame {
    fn from(f: LoggedFrame) -> Self {
        Self {
            ts: f.ts,
            quat: f.quat,
            lat: f.lat,
            lon: f.lon,
            alt: f.alt,
            state: f.state,
        }
    }
}

pub fn start(app: &AppHandle) -> mpsc::Sender<TelemetryFrame> {
    let (tx, rx) = mpsc::channel(CHANNEL_CAP);
    match flights_dir(app) {
        Ok(dir) => {
            tauri::async_runtime::spawn(write_loop(rx, dir));
        }
        Err(e) => eprintln!("recorder: no app data dir ({e}); flight logging is off"),
    }
    tx
}

fn flights_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("flights"))
        .map_err(|e| e.to_string())
}

async fn open_log(dir: &Path) -> std::io::Result<BufWriter<File>> {
    fs::create_dir_all(dir).await?;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file = File::create(dir.join(format!("flight_{secs}.{LOG_EXT}"))).await?;
    Ok(BufWriter::new(file))
}

async fn write_loop(mut rx: mpsc::Receiver<TelemetryFrame>, dir: PathBuf) {
    // File is created on the first frame so idle launches leave nothing behind.
    let Some(first) = rx.recv().await else { return };
    let mut out = match open_log(&dir).await {
        Ok(w) => w,
        Err(e) => {
            eprintln!("recorder: can't open log in {} ({e}); flight logging is off", dir.display());
            return;
        }
    };

    let mut pending = 0u32;
    let mut next = Some(first);
    while let Some(frame) = next.take() {
        let mut line = match serde_json::to_vec(&frame) {
            Ok(l) => l,
            Err(_) => {
                next = rx.recv().await;
                continue;
            }
        };
        line.push(b'\n');
        if let Err(e) = out.write_all(&line).await {
            eprintln!("recorder: write failed ({e}); flight logging stopped");
            return;
        }
        pending += 1;
        // Bounded flush interval: a power cut loses at most FLUSH_EVERY frames.
        if pending >= FLUSH_EVERY {
            if let Err(e) = out.flush().await {
                eprintln!("recorder: flush failed ({e}); flight logging stopped");
                return;
            }
            pending = 0;
        }
        next = rx.recv().await;
    }
    if let Err(e) = out.flush().await {
        eprintln!("recorder: final flush failed ({e})");
    }
}

async fn list_in(dir: &Path) -> Result<Vec<String>, String> {
    let mut rd = match fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut names = Vec::new();
    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(&format!(".{LOG_EXT}")) {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

async fn load_from(dir: &Path, filename: &str) -> Result<Vec<TelemetryFrame>, String> {
    // Bare filenames only: anything with a separator or `..` could escape flights/.
    let bad_name = filename.contains("..")
        || filename.contains('/')
        || filename.contains('\\')
        || !filename.ends_with(&format!(".{LOG_EXT}"));
    if bad_name {
        return Err(format!("invalid log name: {filename}"));
    }
    let text = fs::read_to_string(dir.join(filename))
        .await
        .map_err(|e| e.to_string())?;
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(i, l)| {
            serde_json::from_str::<LoggedFrame>(l)
                .map(TelemetryFrame::from)
                .map_err(|e| format!("{filename} line {}: {e}", i + 1))
        })
        .collect()
}

#[tauri::command]
pub async fn list_flight_logs(app: AppHandle) -> Result<Vec<String>, String> {
    list_in(&flights_dir(&app)?).await
}

#[tauri::command]
pub async fn load_flight_log(
    app: AppHandle,
    filename: String,
) -> Result<Vec<TelemetryFrame>, String> {
    load_from(&flights_dir(&app)?, &filename).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn scratch_dir() -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("apogee_rec_{}_{nanos}", std::process::id()))
    }

    fn frame(ts: u32) -> TelemetryFrame {
        TelemetryFrame {
            ts,
            quat: [1.0, 0.0, 0.0, 0.0],
            lat: 39.9334,
            lon: 32.8597,
            alt: 850.5 + ts as f32,
            state: "BOOST".to_owned(),
        }
    }

    #[tokio::test]
    async fn file_appears_only_after_first_frame() {
        let dir = scratch_dir();
        let (tx, rx) = mpsc::channel(8);
        let task = tokio::spawn(write_loop(rx, dir.clone()));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!dir.exists());

        tx.send(frame(1)).await.unwrap();
        drop(tx);
        task.await.unwrap();
        assert_eq!(list_in(&dir).await.unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn frames_round_trip_through_log() {
        let dir = scratch_dir();
        let (tx, rx) = mpsc::channel(256);
        let task = tokio::spawn(write_loop(rx, dir.clone()));

        // 120 crosses two periodic flushes plus the final one.
        let sent: Vec<_> = (0..120).map(frame).collect();
        for f in &sent {
            tx.send(f.clone()).await.unwrap();
        }
        drop(tx);
        task.await.unwrap();

        let names = list_in(&dir).await.unwrap();
        assert_eq!(names.len(), 1);
        assert_eq!(load_from(&dir, &names[0]).await.unwrap(), sent);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn load_rejects_path_traversal() {
        let dir = scratch_dir();
        for bad in ["../secret.jsonl", "a/b.jsonl", "a\\b.jsonl", "..", "notes.txt"] {
            assert!(load_from(&dir, bad).await.is_err(), "accepted {bad}");
        }
    }
}
