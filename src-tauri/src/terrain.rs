use std::future::Future;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::fs;

const MAX_ZOOM: u32 = 15;
const TILE_BASE_URL: &str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

fn tiles_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("tiles"))
        .map_err(|e| e.to_string())
}

/// Numeric-only coordinates keep the joined path inside `root`.
fn tile_path(root: &Path, z: u32, x: u32, y: u32) -> Result<PathBuf, String> {
    if z > MAX_ZOOM {
        return Err(format!("zoom {z} exceeds {MAX_ZOOM}"));
    }
    let n = 1u32 << z;
    if x >= n || y >= n {
        return Err(format!("tile {z}/{x}/{y} out of range"));
    }
    Ok(root.join(z.to_string()).join(x.to_string()).join(format!("{y}.png")))
}

async fn read_cached(path: &Path) -> Option<Vec<u8>> {
    fs::read(path).await.ok().filter(|b| !b.is_empty())
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    // Rename is atomic: a power cut mid-write leaves a stray .tmp, never a truncated PNG.
    let tmp = path.with_extension("png.tmp");
    fs::write(&tmp, bytes).await?;
    fs::rename(&tmp, path).await
}

async fn tile_or_download<F, Fut>(
    root: &Path,
    z: u32,
    x: u32,
    y: u32,
    download: F,
) -> Result<Vec<u8>, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    let path = tile_path(root, z, x, y)?;
    if let Some(bytes) = read_cached(&path).await {
        return Ok(bytes);
    }
    let bytes = download().await?;
    if bytes.is_empty() {
        return Err(format!("tile {z}/{x}/{y}: empty response"));
    }
    // A failed cache write shouldn't lose a tile we already have in hand.
    if let Err(e) = write_atomic(&path, &bytes).await {
        eprintln!("terrain: can't cache {}: {e}", path.display());
    }
    Ok(bytes)
}

async fn download_tile(z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    let res = reqwest::get(format!("{TILE_BASE_URL}/{z}/{x}/{y}.png"))
        .await
        .map_err(|e| e.to_string())?;
    if res.status() != reqwest::StatusCode::OK {
        return Err(format!("tile {z}/{x}/{y}: HTTP {}", res.status()));
    }
    res.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_terrain_tile(app: AppHandle, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    let root = tiles_dir(&app)?;
    tile_or_download(&root, z, x, y, || download_tile(z, x, y)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch_dir() -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("apogee_tiles_{}_{nanos}", std::process::id()))
    }

    #[test]
    fn rejects_out_of_range_coordinates() {
        let root = Path::new("tiles");
        assert!(tile_path(root, 16, 0, 0).is_err());
        assert!(tile_path(root, 13, 8192, 0).is_err());
        assert!(tile_path(root, 13, 0, 8192).is_err());
        assert!(tile_path(root, 0, 1, 0).is_err());
        assert!(tile_path(root, 15, 32767, 32767).is_ok());
        assert_eq!(
            tile_path(root, 13, 4, 5).unwrap(),
            root.join("13").join("4").join("5.png")
        );
    }

    #[tokio::test]
    async fn miss_downloads_and_caches_then_hit_skips_network() {
        let root = scratch_dir();
        let calls = AtomicU32::new(0);
        let dl = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(vec![1, 2, 3])
        };

        assert_eq!(tile_or_download(&root, 13, 4, 5, dl).await.unwrap(), vec![1, 2, 3]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read(root.join("13/4/5.png")).unwrap(), vec![1, 2, 3]);
        assert!(!root.join("13/4/5.png.tmp").exists());

        let offline = || async { Err::<Vec<u8>, _>("offline".to_owned()) };
        assert_eq!(tile_or_download(&root, 13, 4, 5, offline).await.unwrap(), vec![1, 2, 3]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn empty_cache_file_is_refetched() {
        let root = scratch_dir();
        std::fs::create_dir_all(root.join("13/4")).unwrap();
        std::fs::write(root.join("13/4/5.png"), b"").unwrap();

        let dl = || async { Ok(vec![9u8]) };
        assert_eq!(tile_or_download(&root, 13, 4, 5, dl).await.unwrap(), vec![9]);
        assert_eq!(std::fs::read(root.join("13/4/5.png")).unwrap(), vec![9]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn bad_coordinates_never_reach_download_or_disk() {
        let root = scratch_dir();
        let calls = AtomicU32::new(0);
        let dl = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(vec![1u8])
        };
        assert!(tile_or_download(&root, 99, 0, 0, dl).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!root.exists());
    }
}
