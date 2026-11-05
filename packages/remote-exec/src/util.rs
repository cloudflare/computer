//! Errors, state directories, path checks and hashing shared by the session and run modes.

use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Component, Path, PathBuf};

/// An error reported to the host as `Response.error`.
#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
    pub errno: i32,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Error {
            code,
            message: message.into(),
            errno: 0,
        }
    }
    pub fn protocol(message: impl Into<String>) -> Self {
        Error::new("protocol", message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error {
            code: "io",
            message: e.to_string(),
            errno: e.raw_os_error().unwrap_or(0),
        }
    }
}

impl From<capnp::Error> for Error {
    fn from(e: capnp::Error) -> Self {
        Error::protocol(e.to_string())
    }
}

impl From<capnp::NotInSchema> for Error {
    fn from(e: capnp::NotInSchema) -> Self {
        Error::protocol(format!("unknown message: {e}"))
    }
}

impl From<std::str::Utf8Error> for Error {
    fn from(e: std::str::Utf8Error) -> Self {
        Error::protocol(format!("text isn't UTF-8: {e}"))
    }
}

impl From<nix::Error> for Error {
    fn from(e: nix::Error) -> Self {
        Error {
            code: "io",
            message: e.to_string(),
            errno: e as i32,
        }
    }
}

pub type Res<T> = Result<T, Error>;

/// Where locks, ledgers and indexes live. `REMOTE_EXEC_STATE_DIR` overrides it for tests.
pub fn state_dir() -> PathBuf {
    std::env::var_os("REMOTE_EXEC_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/var/lib/remote-exec".into())
}

/// Where session sockets live. `REMOTE_EXEC_RUN_DIR` overrides it for tests.
pub fn run_dir() -> PathBuf {
    std::env::var_os("REMOTE_EXEC_RUN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/run/remote-exec".into())
}

pub fn private_dir(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path)
}

/// A session id: used in a socket path, so a short, plain name.
pub fn check_id(id: &str) -> Res<()> {
    let ok =
        !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(Error::protocol(format!("bad session id {id:?}")))
    }
}

/// A path relative to the sync root, as the protocol carries it: no leading "/", no "." or ".."
/// components, no empty components, no NUL or newline (the ledger is line-based).
pub fn check_rel(path: &str) -> Res<()> {
    let bad = path.is_empty()
        || path.len() > 4096
        || path.starts_with('/')
        || path.contains('\0')
        || path.contains('\n')
        || path.split('/').any(|c| c.is_empty() || c == "." || c == "..");
    if bad {
        Err(Error::protocol(format!("bad path {path:?}")))
    } else {
        Ok(())
    }
}

/// The directory that will hold `rel`, created as needed (and given to `owner`), refusing to pass
/// through a symlink or a non-directory, so a link planted in the container can't redirect a write
/// outside the root.
pub fn safe_parent(root: &Path, rel: &str, owner: Option<(u32, u32)>) -> io::Result<PathBuf> {
    let mut dir = root.to_path_buf();
    let parts: Vec<&str> = rel.split('/').collect();
    for part in &parts[..parts.len() - 1] {
        dir.push(part);
        match fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(io::Error::other(format!("{} isn't a directory", dir.display()))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&dir)?;
                if let Some((uid, gid)) = owner {
                    std::os::unix::fs::lchown(&dir, Some(uid), Some(gid))?;
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(dir)
}

pub fn link_stays_inside(rel: &str, target: &str) -> bool {
    if target.starts_with('/') {
        return false;
    }
    let mut depth: i64 = rel.split('/').count() as i64 - 1;
    for component in Path::new(target).components() {
        match component {
            Component::ParentDir => depth -= 1,
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            _ => return false,
        }
        if depth < 0 {
            return false;
        }
    }
    true
}

pub fn sha256_file(path: &Path) -> io::Result<[u8; 32]> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// A stable short name for a sync root, for its lock and ledger files.
pub fn root_key(root: &str) -> String {
    hex(&Sha256::digest(root.as_bytes()))[..16].to_string()
}

/// "uid:gid" as numbers. Empty means "the image user".
pub fn parse_owner(owner: &str) -> Res<Option<(u32, u32)>> {
    if owner.is_empty() {
        return Ok(None);
    }
    let (u, g) = owner
        .split_once(':')
        .ok_or_else(|| Error::protocol(format!("user {owner:?} isn't \"uid:gid\"")))?;
    match (u.parse(), g.parse()) {
        (Ok(u), Ok(g)) => Ok(Some((u, g))),
        _ => Err(Error::protocol(format!("user {owner:?} isn't numeric \"uid:gid\""))),
    }
}

pub fn random_token() -> io::Result<[u8; 16]> {
    let mut token = [0u8; 16];
    fs::File::open("/dev/urandom")?.read_exact(&mut token)?;
    Ok(token)
}

pub fn log(event: &str, detail: &str) {
    // stderr is the session's log channel; the host forwards it to Workers logs.
    let detail = detail.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    eprintln!("{{\"remote-exec\":\"{event}\",\"detail\":\"{detail}\"}}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn rel_paths() {
        for ok in ["a", "a/b.txt", ".hidden", "a/.b/c", "with space/x", "unicodé/文件"] {
            assert!(check_rel(ok).is_ok(), "{ok:?}");
        }
        for bad in [
            "",
            "/a",
            "a/../b",
            "..",
            "a//b",
            "./a",
            "a/.",
            "a/",
            "a\nb",
            "a\0b",
            &"x".repeat(4097),
        ] {
            assert!(check_rel(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn session_ids() {
        for ok in ["x1", "abc_DEF-123", &"a".repeat(64)] {
            assert!(check_id(ok).is_ok(), "{ok:?}");
        }
        for bad in ["", "a/b", "../x", "a.b", "a b", &"a".repeat(65)] {
            assert!(check_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn links() {
        assert!(link_stays_inside("link", "target"));
        assert!(link_stays_inside("a/link", "b"));
        assert!(link_stays_inside("a/link", "../b"));
        assert!(link_stays_inside("a/link", "./b/../c"));
        assert!(!link_stays_inside("a/link", "../../b"));
        assert!(!link_stays_inside("link", "../x"));
        assert!(!link_stays_inside("link", "/etc/passwd"));
        assert!(
            link_stays_inside("a/b/link", "x/../../../y"),
            "resolves to y at the root"
        );
        assert!(!link_stays_inside("a/b/link", "x/../../../../y"));
    }

    #[test]
    fn owners() {
        assert_eq!(parse_owner("").unwrap(), None);
        assert_eq!(parse_owner("1000:1001").unwrap(), Some((1000, 1001)));
        for bad in ["root:root", "1000", "1000:", ":1000", "1000:1001:1", "-1:5"] {
            assert!(parse_owner(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn hex_round_trip() {
        assert_eq!(hex(&[0, 1, 0xab, 0xff]), "0001abff");
        assert_eq!(unhex("0001abff").unwrap(), vec![0, 1, 0xab, 0xff]);
        assert_eq!(unhex("ABff").unwrap(), vec![0xab, 0xff]);
        assert!(unhex("abc").is_none());
        assert!(unhex("zz").is_none());
    }

    #[test]
    fn root_keys_are_stable_and_distinct() {
        assert_eq!(root_key("/workspace"), root_key("/workspace"));
        assert_ne!(root_key("/workspace"), root_key("/workspace2"));
        assert_eq!(root_key("/workspace").len(), 16);
    }

    #[test]
    fn hashes_files() {
        let dir = TempDir::new("hash");
        let file = dir.write("abc.txt", "abc");
        assert_eq!(
            hex(&sha256_file(&file).unwrap()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn safe_parent_creates_and_chowns_directories() {
        let dir = TempDir::new("parent");
        let parent = safe_parent(dir.path(), "a/b/c.txt", Some((1234, 5678))).unwrap();
        assert_eq!(parent, dir.path().join("a/b"));
        for d in ["a", "a/b"] {
            let meta = fs::metadata(dir.path().join(d)).unwrap();
            assert!(meta.is_dir());
            assert_eq!((meta.uid(), meta.gid()), (1234, 5678), "{d}");
        }
        // Existing directories are used as they are; a top-level file needs no parent.
        assert_eq!(safe_parent(dir.path(), "a/x.txt", None).unwrap(), dir.path().join("a"));
        assert_eq!(safe_parent(dir.path(), "top.txt", None).unwrap(), dir.path());
    }

    #[test]
    fn safe_parent_refuses_symlinks_and_files() {
        let dir = TempDir::new("parent-refuse");
        let outside = TempDir::new("parent-outside");
        dir.symlink("link", outside.path().to_str().unwrap());
        dir.write("file", "");
        assert!(safe_parent(dir.path(), "link/escape.txt", None).is_err());
        assert!(safe_parent(dir.path(), "file/x.txt", None).is_err());
        assert!(
            fs::read_dir(outside.path()).unwrap().next().is_none(),
            "nothing written through the link"
        );
    }

    #[test]
    fn tokens_are_random() {
        assert_ne!(random_token().unwrap(), random_token().unwrap());
    }

    #[test]
    fn errors_carry_codes() {
        let io: Error = std::io::Error::from_raw_os_error(libc::ENOENT).into();
        assert_eq!((io.code, io.errno), ("io", libc::ENOENT));
        assert_eq!(Error::protocol("x").code, "protocol");
        assert_eq!(Error::new("busy", "y").to_string(), "busy: y");
    }
}
