//! Push (workspace → container) and pull (container → workspace).

use crate::util::{
    check_rel, hex, link_stays_inside, private_dir, root_key, safe_parent, sha256_file, state_dir, unhex, Error, Res,
};
use crate::walk::{walk, Found, Kind, Selector};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{lchown, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct Entry {
    pub path: String,
    pub kind: Kind,
    pub mode: u32,
    pub size: u64,
    pub hash: Vec<u8>,
    pub target: String,
}

impl Entry {
    pub fn of(found: &Found) -> io::Result<Entry> {
        let hash = if found.kind == Kind::File {
            sha256_file(&found.path)?.to_vec()
        } else {
            Vec::new()
        };
        Ok(Entry {
            path: found.rel.clone(),
            kind: found.kind.clone(),
            mode: found.mode,
            size: found.size,
            hash,
            target: found.target.clone(),
        })
    }

    fn same_as(&self, other: &Entry) -> bool {
        self.kind == other.kind
            && match self.kind {
                Kind::File => self.hash == other.hash && self.mode == other.mode,
                Kind::Symlink => self.target == other.target,
            }
    }
}

#[derive(Default)]
pub struct Report {
    pub written: u32,
    pub bytes: u64,
    pub deleted: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

/// What's in the container at `rel`, if it's something we sync.
fn local_entry(root: &Path, rel: &str) -> Option<Entry> {
    let path = root.join(rel);
    let meta = fs::symlink_metadata(&path).ok()?;
    let found = Found {
        rel: rel.to_string(),
        path: path.clone(),
        kind: if meta.file_type().is_symlink() {
            Kind::Symlink
        } else if meta.is_file() {
            Kind::File
        } else {
            return None;
        },
        mode: meta.permissions().mode() & 0o7777,
        size: meta.len(),
        target: if meta.file_type().is_symlink() {
            fs::read_link(&path).ok()?.to_str()?.to_string()
        } else {
            String::new()
        },
    };
    Entry::of(&found).ok()
}

// ── ledger: what earlier pushes put in the container, so push can delete only those ──

/// What a push placed at a path, to tell later whether the container has changed it since.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Placed {
    /// A file with this content hash.
    File(Vec<u8>),
    /// A symlink to this target.
    Link(String),
    /// A symlink recorded before targets were: whether it changed can't be told, so it's kept.
    UnknownLink,
}

impl Placed {
    fn of(entry: &Entry) -> Placed {
        match entry.kind {
            Kind::File => Placed::File(entry.hash.clone()),
            Kind::Symlink => Placed::Link(entry.target.clone()),
        }
    }

    /// Whether `current` is still exactly what was placed.
    fn unchanged(&self, current: &Entry) -> bool {
        match (self, &current.kind) {
            (Placed::File(hash), Kind::File) => current.hash == *hash,
            (Placed::Link(target), Kind::Symlink) => current.target == *target,
            _ => false,
        }
    }
}

fn ledger_path(root: &str) -> PathBuf {
    state_dir().join("ledger").join(root_key(root))
}

/// One line per path: `<hex hash> <path>` for a file, `@<hex target> <path>` for a symlink (hex,
/// as a target may hold spaces), and `- <path>` for a symlink from an older ledger.
fn read_ledger(root: &str) -> BTreeMap<String, Placed> {
    let mut ledger = BTreeMap::new();
    if let Ok(text) = fs::read_to_string(ledger_path(root)) {
        for line in text.lines() {
            if let Some((recorded, path)) = line.split_once(' ') {
                let placed = if recorded == "-" {
                    Some(Placed::UnknownLink)
                } else if let Some(target) = recorded.strip_prefix('@') {
                    unhex(target).and_then(|t| String::from_utf8(t).ok()).map(Placed::Link)
                } else {
                    unhex(recorded).map(Placed::File)
                };
                if let Some(placed) = placed {
                    ledger.insert(path.to_string(), placed);
                }
            }
        }
    }
    ledger
}

fn write_ledger(root: &str, ledger: &BTreeMap<String, Placed>) -> io::Result<()> {
    let path = ledger_path(root);
    private_dir(path.parent().unwrap())?;
    let tmp = path.with_extension("tmp");
    let mut file = fs::File::create(&tmp)?;
    for (p, placed) in ledger {
        let recorded = match placed {
            Placed::File(hash) => hex(hash),
            Placed::Link(target) => format!("@{}", hex(target.as_bytes())),
            Placed::UnknownLink => "-".to_string(),
        };
        writeln!(file, "{recorded} {p}")?;
    }
    file.sync_all()?;
    fs::rename(tmp, path)
}

/// Who owns `rel`, without following a link at the end of it.
fn owner_of(root: &Path, rel: &str) -> Option<(u32, u32)> {
    let meta = fs::symlink_metadata(root.join(rel)).ok()?;
    Some((meta.uid(), meta.gid()))
}

/// A directory where the workspace has a file or a link: the workspace wins, as it does for
/// files' contents.
fn clear_directory(dest: &Path) -> io::Result<()> {
    if fs::symlink_metadata(dest).map(|m| m.is_dir()).unwrap_or(false) {
        fs::remove_dir_all(dest)?;
    }
    Ok(())
}

pub struct Push {
    root: PathBuf,
    root_text: String,
    selector: Arc<Selector>,
    manifest: Vec<Entry>,
    want: HashSet<u32>,
    owner: Option<(u32, u32)>,
    /// Entries the container already has, but owned by someone other than this push's owner.
    chown: Vec<u32>,
    /// Selected paths the host left out of the manifest: still in the workspace, so not deleted.
    keep: HashSet<String>,
    open: HashMap<u32, (fs::File, PathBuf)>,
    done: HashSet<u32>,
    pub report: Report,
}

/// Who a push's files belong to: its owner, or whoever this process runs as.
fn effective_owner(owner: Option<(u32, u32)>) -> (u32, u32) {
    owner.unwrap_or_else(|| (nix::unistd::geteuid().as_raw(), nix::unistd::getegid().as_raw()))
}

impl Push {
    /// Compare the manifest with the container and answer which entries are needed.
    pub fn begin(
        root: &str,
        selector: Selector,
        manifest: Vec<Entry>,
        owner: Option<(u32, u32)>,
    ) -> Res<(Push, Vec<u32>)> {
        let root_path = PathBuf::from(root);
        fs::create_dir_all(&root_path)?;
        let mut want = Vec::new();
        let mut chown = Vec::new();
        let wanted_owner = effective_owner(owner);
        let mut paths = HashSet::new();
        for (i, entry) in manifest.iter().enumerate() {
            check_rel(&entry.path)?;
            if !paths.insert(entry.path.as_str()) {
                return Err(Error::protocol(format!("{} is in the manifest twice", entry.path)));
            }
            match entry.kind {
                Kind::File if entry.hash.len() != 32 => {
                    return Err(Error::protocol(format!("{}: hash must be 32 bytes", entry.path)));
                }
                // The host only sends links that stay inside the root; don't take its word for it.
                Kind::Symlink if !link_stays_inside(&entry.path, &entry.target) => {
                    return Err(Error::protocol(format!("{}: link leaves the root", entry.path)));
                }
                _ => {}
            }
            let current = local_entry(&root_path, &entry.path);
            if !current.map(|c| c.same_as(entry)).unwrap_or(false) {
                want.push(i as u32);
            } else if owner_of(&root_path, &entry.path) != Some(wanted_owner) {
                // The same bytes, but an earlier push gave them to another user: a command
                // running as this push's owner couldn't change them.
                chown.push(i as u32);
            }
        }
        let push = Push {
            root: root_path,
            root_text: root.to_string(),
            selector: Arc::new(selector),
            want: want.iter().copied().collect(),
            manifest,
            owner,
            chown,
            keep: HashSet::new(),
            open: HashMap::new(),
            done: HashSet::new(),
            report: Report::default(),
        };
        Ok((push, want))
    }

    /// Paths the push selects but the host left out of the manifest, over a limit or unreadable:
    /// they still exist in the workspace, so `end` mustn't delete them. Paths that aren't valid
    /// protocol paths can't be in the ledger, so they're ignored rather than refused.
    pub fn keep(&mut self, paths: Vec<String>) {
        self.keep.extend(paths.into_iter().filter(|p| check_rel(p).is_ok()));
    }

    /// Whether the host left `path` out, or a directory above it that it couldn't list.
    fn kept(&self, path: &str) -> bool {
        self.keep.contains(path) || path.match_indices('/').any(|(at, _)| self.keep.contains(&path[..at]))
    }

    pub fn chunk(&mut self, index: u32, data: &[u8], last: bool) -> Res<()> {
        if !self.want.contains(&index) || self.done.contains(&index) {
            return Err(Error::protocol(format!("chunk for entry {index}, which wasn't wanted")));
        }
        let entry = &self.manifest[index as usize];
        if entry.kind != Kind::File {
            return Err(Error::protocol(format!("chunk for symlink {}", entry.path)));
        }
        if !self.open.contains_key(&index) {
            let name = entry.path.rsplit('/').next().unwrap();
            let dir = safe_parent(&self.root, &entry.path, self.owner)?;
            let tmp = dir.join(format!(".{name}.remote-exec.{}.tmp", std::process::id()));
            // The name is predictable, so whatever is there may have been planted: a link would
            // send the write outside the root. Remove it (a link itself, never its target), then
            // create the file exclusively, which never follows a link.
            match fs::remove_file(&tmp) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
            let file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
            self.open.insert(index, (file, tmp));
        }
        let (file, _) = self.open.get_mut(&index).unwrap();
        file.write_all(data)?;
        self.report.bytes += data.len() as u64;
        if last {
            let (file, tmp) = self.open.remove(&index).unwrap();
            let entry = &self.manifest[index as usize];
            file.set_permissions(fs::Permissions::from_mode(entry.mode & 0o7777))?;
            drop(file);
            if let Some((uid, gid)) = self.owner {
                lchown(&tmp, Some(uid), Some(gid))?;
            }
            let dest = self.root.join(&entry.path);
            clear_directory(&dest)?;
            fs::rename(&tmp, &dest)?;
            self.done.insert(index);
            self.report.written += 1;
        }
        Ok(())
    }

    /// Create wanted symlinks, apply ledger deletions, record what this push placed.
    pub fn end(mut self) -> Res<Report> {
        for (_, (_, tmp)) in self.open.drain() {
            let _ = fs::remove_file(tmp);
        }
        let mut ledger = read_ledger(&self.root_text);
        let in_manifest: HashSet<&str> = self.manifest.iter().map(|e| e.path.as_str()).collect();
        for &index in &self.want {
            let entry = &self.manifest[index as usize];
            match entry.kind {
                Kind::Symlink => {
                    let dir = safe_parent(&self.root, &entry.path, self.owner)?;
                    let dest = dir.join(entry.path.rsplit('/').next().unwrap());
                    clear_directory(&dest)?;
                    match fs::remove_file(&dest) {
                        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
                        _ => {}
                    }
                    std::os::unix::fs::symlink(&entry.target, &dest)?;
                    if let Some((uid, gid)) = self.owner {
                        lchown(&dest, Some(uid), Some(gid))?;
                    }
                    self.report.written += 1;
                }
                Kind::File if !self.done.contains(&index) => {
                    self.report.skipped.push((entry.path.clone(), "incomplete".into()));
                }
                Kind::File => {}
            }
        }
        // Unchanged entries that belong to someone else: give them to this push's owner. Through
        // safe_parent, so a directory the container replaced with a link can't redirect it.
        let (uid, gid) = effective_owner(self.owner);
        for &index in &self.chown {
            let entry = &self.manifest[index as usize];
            let dir = safe_parent(&self.root, &entry.path, self.owner)?;
            lchown(dir.join(entry.path.rsplit('/').next().unwrap()), Some(uid), Some(gid))?;
        }
        // Delete what an earlier push placed, this push selects, and the workspace no longer has,
        // unless the container changed it since. A path the host left out (`keep`) is still in the
        // workspace.
        let stale: Vec<String> = ledger
            .keys()
            .filter(|p| self.selector.matches(p) && !in_manifest.contains(p.as_str()) && !self.kept(p))
            .cloned()
            .collect();
        for path in stale {
            let recorded = ledger.remove(&path).unwrap();
            if let Some(current) = local_entry(&self.root, &path) {
                if recorded.unchanged(&current) {
                    fs::remove_file(self.root.join(&path))?;
                    self.report.deleted.push(path);
                }
            }
        }
        for (i, entry) in self.manifest.iter().enumerate() {
            let placed =
                !self.want.contains(&(i as u32)) || self.done.contains(&(i as u32)) || entry.kind == Kind::Symlink;
            if placed {
                ledger.insert(entry.path.clone(), Placed::of(entry));
            }
        }
        write_ledger(&self.root_text, &ledger)?;
        Ok(self.report)
    }
}

pub struct Baseline {
    root: PathBuf,
    selector: Arc<Selector>,
    entries: BTreeMap<String, Entry>,
}

pub struct Changes {
    pub changed: Vec<Entry>,
    pub deleted: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

impl Baseline {
    pub fn take(root: &str, selector: Selector) -> Res<Baseline> {
        let selector = Arc::new(selector);
        let root = PathBuf::from(root);
        let mut entries = BTreeMap::new();
        for found in walk(&root, selector.clone()).found {
            if let Ok(entry) = Entry::of(&found) {
                entries.insert(entry.path.clone(), entry);
            }
        }
        Ok(Baseline {
            root,
            selector,
            entries,
        })
    }

    pub fn changes(&self) -> Changes {
        let walked = walk(&self.root, self.selector.clone());
        let mut changes = Changes {
            changed: Vec::new(),
            deleted: Vec::new(),
            skipped: walked.skipped,
        };
        let mut seen = HashSet::new();
        for found in walked.found {
            seen.insert(found.rel.clone());
            match Entry::of(&found) {
                Ok(entry) => {
                    if !self
                        .entries
                        .get(&entry.path)
                        .map(|b| b.same_as(&entry))
                        .unwrap_or(false)
                    {
                        changes.changed.push(entry);
                    }
                }
                Err(_) => changes.skipped.push((found.rel, "unreadable".into())),
            }
        }
        for path in self.entries.keys() {
            if !seen.contains(path) && fs::symlink_metadata(self.root.join(path)).is_err() {
                changes.deleted.push(path.clone());
            }
        }
        changes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{private_state, TempDir};
    use crate::util::sha256_file;
    use std::os::unix::fs::MetadataExt;

    fn sel(globs: &[&str]) -> Selector {
        Selector::new(&globs.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    fn file(path: &str, content: &str, mode: u32) -> Entry {
        let hash: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest(content.as_bytes()).into();
        Entry {
            path: path.into(),
            kind: Kind::File,
            mode,
            size: content.len() as u64,
            hash: hash.to_vec(),
            target: String::new(),
        }
    }

    fn link(path: &str, target: &str) -> Entry {
        Entry {
            path: path.into(),
            kind: Kind::Symlink,
            mode: 0o777,
            size: 0,
            hash: Vec::new(),
            target: target.into(),
        }
    }

    /// Push `files` (path, content) as a manifest, sending every wanted file whole.
    fn push(
        root: &TempDir,
        globs: &[&str],
        manifest: Vec<(Entry, &str)>,
        owner: Option<(u32, u32)>,
    ) -> (Vec<u32>, Report) {
        let root_text = root.path().to_str().unwrap();
        let contents: Vec<&str> = manifest.iter().map(|(_, c)| *c).collect();
        let (mut state, want) = Push::begin(
            root_text,
            sel(globs),
            manifest.into_iter().map(|(e, _)| e).collect(),
            owner,
        )
        .unwrap();
        for &i in &want {
            if state.manifest[i as usize].kind == Kind::File {
                state.chunk(i, contents[i as usize].as_bytes(), true).unwrap();
            }
        }
        (want, state.end().unwrap())
    }

    #[test]
    fn push_writes_wanted_files_with_modes() {
        private_state();
        let root = TempDir::new("push");
        let (want, report) = push(
            &root,
            &["**"],
            vec![(file("a.txt", "A", 0o644), "A"), (file("bin/run", "#!", 0o755), "#!")],
            None,
        );
        assert_eq!(want, [0, 1]);
        assert_eq!((report.written, report.bytes), (2, 3));
        assert_eq!(root.read("a.txt"), "A");
        assert_eq!(
            fs::metadata(root.path().join("bin/run")).unwrap().permissions().mode() & 0o777,
            0o755
        );
        // No temporary files left behind.
        assert_eq!(fs::read_dir(root.path().join("bin")).unwrap().count(), 1);
    }

    #[test]
    fn push_wants_only_what_differs() {
        private_state();
        let root = TempDir::new("push-diff");
        root.write("same.txt", "same");
        root.write("changed.txt", "old");
        let mode_changed = root.write("mode.sh", "x");
        fs::set_permissions(&mode_changed, fs::Permissions::from_mode(0o644)).unwrap();
        root.symlink("link", "same.txt");
        root.symlink("relink", "same.txt");
        let manifest = vec![
            file("same.txt", "same", 0o644),
            file("changed.txt", "new", 0o644),
            file("mode.sh", "x", 0o755),
            file("missing.txt", "m", 0o644),
            link("link", "same.txt"),
            link("relink", "changed.txt"),
        ];
        let (_, want) = Push::begin(root.path().to_str().unwrap(), sel(&["**"]), manifest, None).unwrap();
        assert_eq!(want, [1, 2, 3, 5]);
    }

    #[test]
    fn push_streams_a_file_in_chunks() {
        private_state();
        let root = TempDir::new("push-chunks");
        let content = "x".repeat(10);
        let (mut state, want) = Push::begin(
            root.path().to_str().unwrap(),
            sel(&["**"]),
            vec![file("big", &content, 0o600)],
            None,
        )
        .unwrap();
        assert_eq!(want, [0]);
        state.chunk(0, b"xxxx", false).unwrap();
        assert!(!root.exists("big"), "not visible until the last chunk");
        state.chunk(0, b"xxxx", false).unwrap();
        state.chunk(0, b"xx", true).unwrap();
        assert_eq!(state.end().unwrap().written, 1);
        assert_eq!(root.read("big"), content);
    }

    #[test]
    fn push_rejects_protocol_violations() {
        private_state();
        let root = TempDir::new("push-bad");
        root.write("same.txt", "same");
        let r = root.path().to_str().unwrap();
        let manifest = vec![
            file("same.txt", "same", 0o644),
            file("new.txt", "n", 0o644),
            link("l", "new.txt"),
        ];
        let (mut state, want) = Push::begin(r, sel(&["**"]), manifest, None).unwrap();
        assert_eq!(want, [1, 2]);
        assert_eq!(state.chunk(0, b"x", true).unwrap_err().code, "protocol", "not wanted");
        assert_eq!(state.chunk(9, b"x", true).unwrap_err().code, "protocol", "out of range");
        assert_eq!(
            state.chunk(2, b"x", true).unwrap_err().code,
            "protocol",
            "chunk for a symlink"
        );
        state.chunk(1, b"n", true).unwrap();
        assert_eq!(
            state.chunk(1, b"n", true).unwrap_err().code,
            "protocol",
            "after its last chunk"
        );
        for bad in ["../escape", "/abs", "a//b"] {
            assert!(
                Push::begin(r, sel(&["**"]), vec![file(bad, "", 0o644)], None).is_err(),
                "{bad}"
            );
        }
        let mut short_hash = file("x", "x", 0o644);
        short_hash.hash.truncate(3);
        assert!(Push::begin(r, sel(&["**"]), vec![short_hash], None).is_err());
    }

    #[test]
    fn push_refuses_to_write_through_a_planted_symlink() {
        private_state();
        let root = TempDir::new("push-link");
        let outside = TempDir::new("push-outside");
        root.symlink("dir", outside.path().to_str().unwrap());
        let (mut state, want) = Push::begin(
            root.path().to_str().unwrap(),
            sel(&["**"]),
            vec![file("dir/evil", "x", 0o644)],
            None,
        )
        .unwrap();
        assert_eq!(want, [0]);
        assert!(state.chunk(0, b"x", true).is_err());
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[test]
    fn push_refuses_to_write_through_a_planted_temporary_file() {
        private_state();
        let root = TempDir::new("push-tmp-link");
        let outside = TempDir::new("push-tmp-outside");
        let victim = outside.write("victim", "precious");
        // The temporary file's name is predictable: a command could plant a link there.
        root.symlink(
            &format!(".f.remote-exec.{}.tmp", std::process::id()),
            victim.to_str().unwrap(),
        );
        let (_, report) = push(&root, &["**"], vec![(file("f", "pushed", 0o644), "pushed")], None);
        assert_eq!(report.written, 1);
        assert_eq!(root.read("f"), "pushed");
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
    }

    #[test]
    fn push_replaces_a_directory_with_a_symlink() {
        private_state();
        let root = TempDir::new("push-link-over-dir");
        root.write("l/inside", "x");
        let (_, report) = push(&root, &["**"], vec![(link("l", "t"), "")], None);
        assert_eq!(report.written, 1);
        assert_eq!(fs::read_link(root.path().join("l")).unwrap().to_str(), Some("t"));
    }

    #[test]
    fn push_refuses_duplicate_paths_and_links_that_escape() {
        private_state();
        let root = TempDir::new("push-refuse");
        let r = root.path().to_str().unwrap();
        let twice = vec![file("a", "1", 0o644), file("a", "2", 0o644)];
        assert_eq!(
            Push::begin(r, sel(&["**"]), twice, None).err().unwrap().code,
            "protocol"
        );
        for target in ["/etc/passwd", "../outside", "d/../../x"] {
            let e = Push::begin(r, sel(&["**"]), vec![link("l", target)], None)
                .err()
                .unwrap();
            assert_eq!(e.code, "protocol", "{target}");
        }
        assert!(Push::begin(r, sel(&["**"]), vec![link("d/l", "../t")], None).is_ok());
    }

    #[test]
    fn push_reports_incomplete_files() {
        private_state();
        let root = TempDir::new("push-incomplete");
        let (mut state, _) = Push::begin(
            root.path().to_str().unwrap(),
            sel(&["**"]),
            vec![file("a", "abc", 0o644)],
            None,
        )
        .unwrap();
        state.chunk(0, b"ab", false).unwrap();
        let report = state.end().unwrap();
        assert_eq!(report.skipped, [("a".to_string(), "incomplete".to_string())]);
        assert!(!root.exists("a"));
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0, "temp file removed");
    }

    #[test]
    fn push_creates_symlinks_and_chowns_to_the_owner() {
        private_state();
        let root = TempDir::new("push-owner");
        let (_, report) = push(
            &root,
            &["**"],
            vec![(file("d/f.txt", "f", 0o644), "f"), (link("d/l", "f.txt"), "")],
            Some((4321, 8765)),
        );
        assert_eq!(report.written, 2);
        assert_eq!(fs::read_link(root.path().join("d/l")).unwrap().to_str(), Some("f.txt"));
        for p in ["d", "d/f.txt", "d/l"] {
            let meta = fs::symlink_metadata(root.path().join(p)).unwrap();
            assert_eq!((meta.uid(), meta.gid()), (4321, 8765), "{p}");
        }
    }

    #[test]
    fn push_deletes_only_what_an_earlier_push_placed_and_nobody_changed() {
        private_state();
        let root = TempDir::new("push-ledger");
        push(
            &root,
            &["src/**"],
            vec![
                (file("src/a", "a", 0o644), "a"),
                (file("src/b", "b", 0o644), "b"),
                (file("src/c", "c", 0o644), "c"),
            ],
            None,
        );
        root.write("src/made-here", "container's own");
        root.write("src/c", "changed by a command");
        // The workspace now has only src/a: b was deleted there, c too, but the container changed c.
        let (_, report) = push(&root, &["src/**"], vec![(file("src/a", "a", 0o644), "a")], None);
        assert_eq!(report.deleted, ["src/b"]);
        assert!(root.exists("src/a") && root.exists("src/made-here") && root.exists("src/c"));
        // A push that doesn't select a path never deletes it.
        root.write("other/x", "x");
        push(&root, &["other/**"], vec![(file("other/x", "x", 0o644), "x")], None);
        let (_, report) = push(&root, &["src/**"], vec![], None);
        assert_eq!(report.deleted, ["src/a"]);
        assert!(root.exists("other/x"));
    }

    #[test]
    fn push_deletes_symlinks_it_placed() {
        private_state();
        let root = TempDir::new("push-ledger-link");
        push(
            &root,
            &["**"],
            vec![(file("t", "t", 0o644), "t"), (link("l", "t"), "")],
            None,
        );
        let (_, report) = push(&root, &["**"], vec![(file("t", "t", 0o644), "t")], None);
        assert_eq!(report.deleted, ["l"]);
        assert!(!root.exists("l"));
    }

    #[test]
    fn ledger_survives_reading_back() {
        private_state();
        let root = TempDir::new("ledger");
        let r = root.path().to_str().unwrap();
        let mut ledger = BTreeMap::new();
        ledger.insert("a b/c.txt".to_string(), Placed::File(vec![1u8; 32]));
        ledger.insert("link".to_string(), Placed::Link("../a b/c.txt".into()));
        ledger.insert("old link".to_string(), Placed::UnknownLink);
        write_ledger(r, &ledger).unwrap();
        assert_eq!(read_ledger(r), ledger);
    }

    #[test]
    fn ledger_reads_links_recorded_before_targets_were() {
        private_state();
        let root = TempDir::new("ledger-old");
        let r = root.path().to_str().unwrap();
        let path = ledger_path(r);
        private_dir(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("{} a.txt\n- link\n", hex(&[2u8; 32]))).unwrap();
        let ledger = read_ledger(r);
        assert_eq!(ledger["a.txt"], Placed::File(vec![2u8; 32]));
        assert_eq!(ledger["link"], Placed::UnknownLink);
    }

    #[test]
    fn push_keeps_a_retargeted_link_and_one_from_an_old_ledger() {
        private_state();
        let root = TempDir::new("push-ledger-relink");
        push(
            &root,
            &["**"],
            vec![
                (file("v1", "1", 0o644), "1"),
                (link("current", "v1"), ""),
                (link("old", "v1"), ""),
            ],
            None,
        );
        // A command points the link elsewhere; the workspace then drops it.
        fs::remove_file(root.path().join("current")).unwrap();
        root.symlink("current", "v2");
        // And `old` reads as a link recorded before targets were.
        let r = root.path().to_str().unwrap();
        let mut ledger = read_ledger(r);
        ledger.insert("old".into(), Placed::UnknownLink);
        write_ledger(r, &ledger).unwrap();
        let (_, report) = push(&root, &["**"], vec![(file("v1", "1", 0o644), "1")], None);
        assert!(report.deleted.is_empty(), "{:?}", report.deleted);
        assert_eq!(fs::read_link(root.path().join("current")).unwrap().to_str(), Some("v2"));
        assert!(fs::symlink_metadata(root.path().join("old")).is_ok());
    }

    #[test]
    fn push_keeps_what_the_host_left_out() {
        private_state();
        let root = TempDir::new("push-keep");
        push(
            &root,
            &["**"],
            vec![(file("data.bin", "big", 0o644), "big"), (file("a", "a", 0o644), "a")],
            None,
        );
        // The next push skips data.bin for size, and says so: it's still in the workspace.
        let (mut state, _) = Push::begin(
            root.path().to_str().unwrap(),
            sel(&["**"]),
            vec![file("a", "a", 0o644)],
            None,
        )
        .unwrap();
        state.keep(vec!["data.bin".into(), "../bad".into(), "bad\nname".into()]);
        let report = state.end().unwrap();
        assert!(report.deleted.is_empty(), "{:?}", report.deleted);
        assert_eq!(root.read("data.bin"), "big");
        // It stays in the ledger, so a later push that leaves it out for good still deletes it.
        let (_, report) = push(&root, &["**"], vec![(file("a", "a", 0o644), "a")], None);
        assert_eq!(report.deleted, ["data.bin"]);
    }

    #[test]
    fn push_keeps_everything_under_a_directory_the_host_couldnt_list() {
        private_state();
        let root = TempDir::new("push-keep-dir");
        push(
            &root,
            &["**"],
            vec![
                (file("src/a.txt", "a", 0o644), "a"),
                (file("src/deep/b.txt", "b", 0o644), "b"),
                (file("srcfile", "c", 0o644), "c"),
            ],
            None,
        );
        // src couldn't be listed this time; srcfile is just gone.
        let (mut state, _) = Push::begin(root.path().to_str().unwrap(), sel(&["**"]), Vec::new(), None).unwrap();
        state.keep(vec!["src".into()]);
        let report = state.end().unwrap();
        assert_eq!(
            report.deleted,
            ["srcfile"],
            "a sibling that only shares the prefix isn't kept"
        );
        assert!(root.exists("src/a.txt") && root.exists("src/deep/b.txt"));
    }

    #[test]
    fn push_gives_unchanged_files_and_links_to_a_new_owner() {
        private_state();
        let root = TempDir::new("push-reown");
        let manifest = || vec![(file("d/f.txt", "f", 0o644), "f"), (link("d/l", "f.txt"), "")];
        push(&root, &["**"], manifest(), Some((4321, 8765)));
        let (want, report) = push(&root, &["**"], manifest(), Some((1111, 2222)));
        assert!(want.is_empty() && report.written == 0, "nothing re-sent");
        for p in ["d/f.txt", "d/l"] {
            let meta = fs::symlink_metadata(root.path().join(p)).unwrap();
            assert_eq!((meta.uid(), meta.gid()), (1111, 2222), "{p}");
        }
        // No owner: whoever runs the session, as files it writes would be.
        push(&root, &["**"], manifest(), None);
        let meta = fs::symlink_metadata(root.path().join("d/f.txt")).unwrap();
        assert_eq!(
            (meta.uid(), meta.gid()),
            (nix::unistd::geteuid().as_raw(), nix::unistd::getegid().as_raw())
        );
    }

    #[test]
    fn push_reowns_nothing_through_a_planted_directory_link() {
        private_state();
        let root = TempDir::new("push-reown-link");
        let outside = TempDir::new("push-reown-outside");
        outside.write("f.txt", "f");
        root.symlink("d", outside.path().to_str().unwrap());
        let (mut state, want) = Push::begin(
            root.path().to_str().unwrap(),
            sel(&["**"]),
            vec![file("d/f.txt", "f", 0o644)],
            Some((4321, 8765)),
        )
        .unwrap();
        assert!(want.is_empty(), "the same bytes, through the link");
        assert!(state.chown.contains(&0));
        state.keep(Vec::new());
        assert!(state.end().is_err());
        let meta = fs::metadata(outside.path().join("f.txt")).unwrap();
        assert_ne!((meta.uid(), meta.gid()), (4321, 8765));
    }

    #[test]
    fn baseline_reports_new_changed_and_deleted() {
        let root = TempDir::new("baseline");
        root.write(".gitignore", "node_modules/\n");
        root.write("keep.txt", "same");
        root.write("edit.txt", "before");
        root.write("gone.txt", "bye");
        let chmod = root.write("chmod.sh", "x");
        root.symlink("link", "keep.txt");
        let base = Baseline::take(root.path().to_str().unwrap(), sel(&["**"])).unwrap();
        root.write("edit.txt", "after");
        fs::remove_file(root.path().join("gone.txt")).unwrap();
        root.write("new/file.txt", "new");
        root.write("node_modules/dep.js", "ignored");
        fs::set_permissions(&chmod, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_file(root.path().join("link")).unwrap();
        root.symlink("link", "edit.txt");
        let changes = base.changes();
        let changed: Vec<&str> = changes.changed.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(changed, ["chmod.sh", "edit.txt", "link", "new/file.txt"]);
        assert_eq!(changes.deleted, ["gone.txt"]);
        let edit = changes.changed.iter().find(|e| e.path == "edit.txt").unwrap();
        assert_eq!(edit.hash, sha256_file(&root.path().join("edit.txt")).unwrap().to_vec());
        assert_eq!(edit.size, 5);
    }

    #[test]
    fn baseline_of_nothing_reports_nothing() {
        let root = TempDir::new("baseline-empty");
        root.write("a", "a");
        let base = Baseline::take(root.path().to_str().unwrap(), sel(&["src/**"])).unwrap();
        root.write("b", "b");
        let changes = base.changes();
        assert!(changes.changed.is_empty() && changes.deleted.is_empty());
    }
}
