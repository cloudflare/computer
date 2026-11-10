//! Helpers for unit tests: temporary directories, a private state directory, and the shared
//! fixtures in tests/fixtures (also read by the TypeScript tests).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("remote-exec-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn write(&self, rel: &str, content: &str) -> PathBuf {
        let full = self.0.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, content).unwrap();
        full
    }

    pub fn symlink(&self, rel: &str, target: &str) {
        let full = self.0.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target, full).unwrap();
    }

    pub fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.0.join(rel)).unwrap()
    }

    pub fn exists(&self, rel: &str) -> bool {
        fs::symlink_metadata(self.0.join(rel)).is_ok()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Point REMOTE_EXEC_STATE_DIR at a private directory, once per test process, so ledgers and
/// locks don't touch /var/lib/remote-exec. Each test uses its own sync root, and those are keyed
/// separately inside it.
pub fn private_state() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join(format!("remote-exec-state-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("REMOTE_EXEC_STATE_DIR", &dir);
    });
}

pub fn fixtures_dir(kind: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(kind)
}
