//! The per-root lock: an flock held by the session for the whole call. The kernel
//! drops it when the session exits, however it exits, so there's nothing to expire or clean up.

use crate::util::{private_dir, root_key, state_dir, Error, Res};
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

pub struct Lock {
    _file: File,
    pub waited: Duration,
}

pub fn acquire(root: &str, timeout: Duration) -> Res<Lock> {
    let dir = state_dir().join("locks");
    private_dir(&dir)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(root_key(root)))?;
    let start = Instant::now();
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Lock {
                _file: file,
                waited: start.elapsed(),
            });
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
            return Err(err.into());
        }
        if start.elapsed() >= timeout {
            return Err(Error::new("busy", format!("another call holds the lock on {root}")));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::private_state;

    #[test]
    fn one_holder_per_root() {
        private_state();
        let root = format!("/lock-test/{}", std::process::id());
        let first = acquire(&root, Duration::from_millis(0)).unwrap();
        assert!(first.waited < Duration::from_millis(50));
        let busy = acquire(&root, Duration::from_millis(100)).err().unwrap();
        assert_eq!(busy.code, "busy");
        // Another root isn't affected.
        drop(acquire(&format!("{root}-other"), Duration::from_millis(0)).unwrap());
        // Released when the holder goes away (the kernel does it when a session exits).
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(first);
        });
        let second = acquire(&root, Duration::from_secs(5)).unwrap();
        assert!(
            second.waited >= Duration::from_millis(100),
            "waited {:?}",
            second.waited
        );
        releaser.join().unwrap();
    }
}
