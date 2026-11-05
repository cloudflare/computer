//! Selecting files: globs plus `.gitignore` rules.
//!
//! Ignore rules come first: a path is a candidate only if no `.gitignore` from the root down, no
//! `.git/info/exclude` and not the built-in `.git/` excludes it. Then a candidate is selected if
//! it matches a positive glob and no negative one. Selection is a separate `GlobSet` on purpose:
//! `ignore`'s overrides would beat `.gitignore`, the opposite of what we want.

use crate::util::{link_stays_inside, Error, Res};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct Selector {
    positive: GlobSet,
    negative: GlobSet,
    /// Static prefix of each positive glob ("app/src" for "app/src/**/*.ts"), to prune the walk.
    prefixes: Vec<String>,
}

fn glob(pattern: &str) -> Res<globset::Glob> {
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|e| Error::protocol(format!("bad glob {pattern:?}: {e}")))
}

fn static_prefix(pattern: &str) -> String {
    let mut parts = Vec::new();
    for part in pattern.split('/') {
        if part.contains(['*', '?', '[', '{', '\\']) {
            break;
        }
        parts.push(part);
    }
    // The last literal segment may be a file name; keep only directories.
    if parts.len() == pattern.split('/').count() {
        parts.pop();
    }
    parts.join("/")
}

impl Selector {
    pub fn new(globs: &[String]) -> Res<Selector> {
        let mut positive = GlobSetBuilder::new();
        let mut negative = GlobSetBuilder::new();
        let mut prefixes = Vec::new();
        for g in globs {
            if let Some(neg) = g.strip_prefix('!') {
                negative.add(glob(neg)?);
            } else {
                positive.add(glob(g)?);
                prefixes.push(static_prefix(g));
            }
        }
        let build = |b: GlobSetBuilder| b.build().map_err(|e| Error::protocol(e.to_string()));
        Ok(Selector {
            positive: build(positive)?,
            negative: build(negative)?,
            prefixes,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.prefixes.is_empty()
    }

    pub fn matches(&self, rel: &str) -> bool {
        self.positive.is_match(rel) && !self.negative.is_match(rel)
    }

    /// Whether a directory can contain anything a positive glob selects.
    fn may_enter(&self, dir: &str) -> bool {
        self.prefixes
            .iter()
            .any(|p| p.is_empty() || p == dir || p.starts_with(&format!("{dir}/")) || dir.starts_with(&format!("{p}/")))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    File,
    Symlink,
}

#[derive(Clone, Debug)]
pub struct Found {
    pub rel: String,
    pub path: PathBuf,
    pub kind: Kind,
    pub mode: u32,
    pub size: u64,
    pub target: String,
}

pub struct Walked {
    pub found: Vec<Found>,
    pub skipped: Vec<(String, String)>,
}

pub fn walk(root: &Path, selector: Arc<Selector>) -> Walked {
    let mut walked = Walked {
        found: Vec::new(),
        skipped: Vec::new(),
    };
    if selector.is_empty() || !root.is_dir() {
        return walked;
    }
    let filter_root = root.to_path_buf();
    let filter_selector = selector.clone();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .ignore(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) && entry.depth() > 0 {
                let rel = entry.path().strip_prefix(&filter_root).ok().and_then(|p| p.to_str());
                return rel.map(|r| filter_selector.may_enter(r)).unwrap_or(false);
            }
            true
        })
        .build();
    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(e) => {
                walked.skipped.push((String::new(), format!("unreadable: {e}")));
                continue;
            }
        };
        if entry.depth() == 0 {
            continue;
        }
        let Some(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            continue;
        }
        let Some(rel) = entry
            .path()
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.to_str())
            .map(String::from)
        else {
            continue; // not UTF-8: can't be named in the protocol
        };
        if !selector.matches(&rel) {
            continue;
        }
        if rel.contains('\n') {
            walked.skipped.push((rel, "unsupported".into()));
            continue;
        }
        let path = entry.path().to_path_buf();
        if file_type.is_symlink() {
            match fs::read_link(&path).ok().and_then(|t| t.to_str().map(String::from)) {
                Some(target) if link_stays_inside(&rel, &target) => walked.found.push(Found {
                    rel,
                    path,
                    kind: Kind::Symlink,
                    mode: 0o777,
                    size: 0,
                    target,
                }),
                _ => walked.skipped.push((rel, "symlink-escape".into())),
            }
        } else if file_type.is_file() {
            match fs::symlink_metadata(&path) {
                Ok(meta) => walked.found.push(Found {
                    rel,
                    path,
                    kind: Kind::File,
                    mode: meta.permissions().mode() & 0o7777,
                    size: meta.len(),
                    target: String::new(),
                }),
                Err(_) => walked.skipped.push((rel, "unreadable".into())),
            }
        } else {
            walked.skipped.push((rel, "unsupported".into()));
        }
    }
    walked.found.sort_by(|a, b| a.rel.cmp(&b.rel));
    walked
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{fixtures_dir, TempDir};
    use serde_json::Value;

    fn select(root: &Path, globs: &[&str]) -> Walked {
        let globs: Vec<String> = globs.iter().map(|s| s.to_string()).collect();
        walk(root, Arc::new(Selector::new(&globs).unwrap()))
    }

    fn names(walked: &Walked) -> Vec<String> {
        walked.found.iter().map(|f| f.rel.clone()).collect()
    }

    /// The shared conformance suite (tests/fixtures/ignore), also run by the TypeScript walker and
    /// checked against git itself by the Node tests.
    #[test]
    fn ignore_fixtures() {
        let mut count = 0;
        for entry in fs::read_dir(fixtures_dir("fixtures/ignore")).unwrap() {
            let path = entry.unwrap().path();
            let fixture: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let dir = TempDir::new("fixture");
            for (rel, content) in fixture["files"].as_object().unwrap() {
                dir.write(rel, content.as_str().unwrap());
            }
            if let Some(links) = fixture["symlinks"].as_object() {
                for (rel, target) in links {
                    dir.symlink(rel, target.as_str().unwrap());
                }
            }
            if let Some(exclude) = fixture["exclude"].as_str() {
                dir.write(".git/info/exclude", exclude);
            }
            for case in fixture["cases"].as_array().unwrap() {
                let globs: Vec<&str> = case["globs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|g| g.as_str().unwrap())
                    .collect();
                let expected: Vec<String> = case["expected"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| e.as_str().unwrap().to_string())
                    .collect();
                let walked = select(dir.path(), &globs);
                assert_eq!(names(&walked), expected, "fixture {name}, globs {globs:?}");
                if let Some(skipped) = case["skipped"].as_array() {
                    let mut got: Vec<String> = walked.skipped.iter().map(|(p, _)| p.clone()).collect();
                    got.sort();
                    let want: Vec<String> = skipped.iter().map(|s| s.as_str().unwrap().to_string()).collect();
                    assert_eq!(got, want, "fixture {name}: skipped");
                }
                count += 1;
            }
        }
        assert!(count >= 10, "only {count} fixture cases ran");
    }

    #[test]
    fn reports_kinds_modes_and_targets() {
        let dir = TempDir::new("kinds");
        let script = dir.write("run.sh", "#!/bin/sh\n");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        dir.write("data.txt", "hello");
        dir.symlink("link", "data.txt");
        let walked = select(dir.path(), &["**"]);
        let by_name = |n: &str| walked.found.iter().find(|f| f.rel == n).unwrap().clone();
        assert_eq!((by_name("run.sh").kind, by_name("run.sh").mode), (Kind::File, 0o755));
        assert_eq!((by_name("data.txt").size, by_name("data.txt").mode), (5, 0o644));
        assert_eq!(
            (by_name("link").kind, by_name("link").target.as_str()),
            (Kind::Symlink, "data.txt")
        );
    }

    #[test]
    fn skips_special_files() {
        let dir = TempDir::new("special");
        let fifo = std::ffi::CString::new(dir.path().join("pipe").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);
        dir.write("ok.txt", "");
        let walked = select(dir.path(), &["**"]);
        assert_eq!(names(&walked), ["ok.txt"]);
        assert_eq!(walked.skipped, [("pipe".to_string(), "unsupported".to_string())]);
    }

    #[test]
    fn empty_selection_and_missing_root() {
        let dir = TempDir::new("empty");
        dir.write("a.txt", "");
        assert!(select(dir.path(), &[]).found.is_empty());
        assert!(select(&dir.path().join("missing"), &["**"]).found.is_empty());
        assert!(
            select(dir.path(), &["!a.txt"]).found.is_empty(),
            "only negative globs select nothing"
        );
    }

    #[test]
    fn prefixes() {
        assert_eq!(static_prefix("app/src/**/*.ts"), "app/src");
        assert_eq!(static_prefix("**"), "");
        assert_eq!(static_prefix("a/b.txt"), "a");
        assert_eq!(static_prefix("b.txt"), "");
        assert_eq!(static_prefix("a/{b,c}/d"), "a");
    }

    #[test]
    fn prunes_directories_outside_every_prefix() {
        let sel = Selector::new(&["app/src/**".to_string(), "docs/*.md".to_string()]).unwrap();
        for dir in ["app", "app/src", "app/src/deep", "docs"] {
            assert!(sel.may_enter(dir), "{dir}");
        }
        for dir in ["node_modules", "application", "apps", "ap"] {
            assert!(!sel.may_enter(dir), "{dir}");
        }
        assert!(Selector::new(&["**/*.ts".to_string()])
            .unwrap()
            .may_enter("anything/at/all"));
    }

    #[test]
    fn bad_globs_are_protocol_errors() {
        assert_eq!(Selector::new(&["a/[".to_string()]).err().unwrap().code, "protocol");
    }
}
