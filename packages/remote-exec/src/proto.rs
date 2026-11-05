//! Generated message types, framing helpers, and conversions to and from our own structs.

pub use crate::exec_capnp;

use crate::sync::Entry;
use crate::util::{Error, Res};
use crate::walk::Kind;
use capnp::message::{Builder, HeapAllocator, ReaderOptions};
use exec_capnp::entry;

pub const PROTOCOL: u16 = exec_capnp::PROTOCOL_VERSION;

/// Limits for decoding: a message is at most a 1 MiB chunk plus a little, or a manifest. Nesting
/// in our schema is shallow.
pub fn reader_options() -> ReaderOptions {
    let mut options = ReaderOptions::new();
    options
        .traversal_limit_in_words(Some(64 * 1024 * 1024 / 8))
        .nesting_limit(16);
    options
}

pub fn to_bytes(message: &Builder<HeapAllocator>) -> Vec<u8> {
    capnp::serialize::write_message_to_words(message)
}

pub fn from_bytes(bytes: &[u8]) -> Res<capnp::message::Reader<capnp::serialize::OwnedSegments>> {
    let mut slice = bytes;
    Ok(capnp::serialize::read_message(&mut slice, reader_options())?)
}

pub fn read_entry(reader: entry::Reader) -> Res<Entry> {
    Ok(Entry {
        path: reader.get_path()?.to_str()?.to_string(),
        kind: match reader.get_kind()? {
            entry::Kind::File => Kind::File,
            entry::Kind::Symlink => Kind::Symlink,
        },
        mode: reader.get_mode(),
        size: reader.get_size(),
        hash: reader.get_hash()?.to_vec(),
        target: reader.get_target()?.to_str()?.to_string(),
    })
}

pub fn write_entry(mut builder: entry::Builder, entry: &Entry) {
    builder.set_path(entry.path.as_str());
    builder.set_kind(match entry.kind {
        Kind::File => entry::Kind::File,
        Kind::Symlink => entry::Kind::Symlink,
    });
    builder.set_mode(entry.mode);
    builder.set_size(entry.size);
    builder.set_hash(&entry.hash);
    builder.set_target(entry.target.as_str());
}

pub fn text_list(list: capnp::text_list::Reader) -> Res<Vec<String>> {
    let mut out = Vec::with_capacity(list.len() as usize);
    for item in list.iter() {
        out.push(item?.to_str()?.to_string());
    }
    Ok(out)
}

pub fn check_globs(globs: &[String]) -> Res<()> {
    for g in globs {
        let body = g.strip_prefix('!').unwrap_or(g);
        if body.is_empty() || body.starts_with('/') || body.split('/').any(|c| c == "..") {
            return Err(Error::protocol(format!(
                "bad glob {g:?}: globs are relative to the root"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::exec_capnp::{request, response};
    use crate::testutil::fixtures_dir;
    use crate::util::{hex, unhex};
    use serde_json::{json, Value};
    use std::fs;

    fn entry_json(e: &Entry) -> Value {
        json!({
            "path": e.path, "kind": if e.kind == Kind::File { "file" } else { "symlink" },
            "mode": e.mode, "size": e.size, "hash": hex(&e.hash), "target": e.target,
        })
    }

    fn entry_from(v: &Value) -> Entry {
        Entry {
            path: v["path"].as_str().unwrap().into(),
            kind: if v["kind"] == "file" { Kind::File } else { Kind::Symlink },
            mode: v["mode"].as_u64().unwrap() as u32,
            size: v["size"].as_u64().unwrap(),
            hash: unhex(v["hash"].as_str().unwrap()).unwrap(),
            target: v["target"].as_str().unwrap().into(),
        }
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect()
    }

    fn text_list_json(list: capnp::text_list::Reader) -> Value {
        json!(text_list(list).unwrap())
    }

    /// A decoded request as the JSON in tests/golden/requests.json describes it.
    fn request_json(r: request::Reader) -> Value {
        use request::Which;
        match r.which().unwrap() {
            Which::Begin(b) => {
                let b = b.unwrap();
                assert_eq!(b.get_protocol(), PROTOCOL);
                json!({ "type": "begin", "id": b.get_id().unwrap().to_str().unwrap(), "root": b.get_root().unwrap().to_str().unwrap(),
                        "lock": b.get_lock(), "lockTimeoutMs": b.get_lock_timeout_ms() })
            }
            Which::Push(p) => {
                let p = p.unwrap();
                let sel = p.get_selection().unwrap();
                let manifest: Vec<Value> = p
                    .get_manifest()
                    .unwrap()
                    .iter()
                    .map(|e| entry_json(&read_entry(e).unwrap()))
                    .collect();
                json!({ "type": "push",
                        "selection": { "root": sel.get_root().unwrap().to_str().unwrap(), "globs": text_list_json(sel.get_globs().unwrap()) },
                        "manifest": manifest, "owner": p.get_owner().unwrap().to_str().unwrap() })
            }
            Which::Chunk(c) => {
                let c = c.unwrap();
                json!({ "type": "chunk", "index": c.get_index(), "data": hex(c.get_data().unwrap()), "last": c.get_last() })
            }
            Which::PushEnd(()) => json!({ "type": "pushEnd" }),
            Which::Prepare(p) => {
                let p = p.unwrap();
                let spec = p.get_spec().unwrap();
                let mut env = serde_json::Map::new();
                for var in spec.get_env().unwrap().iter() {
                    env.insert(
                        var.get_name().unwrap().to_str().unwrap().into(),
                        json!(var.get_value().unwrap().to_str().unwrap()),
                    );
                }
                let pull = p.get_pull().unwrap();
                json!({ "type": "prepare",
                        "spec": { "argv": text_list_json(spec.get_argv().unwrap()), "cwd": spec.get_cwd().unwrap().to_str().unwrap(),
                                  "env": env, "user": spec.get_user().unwrap().to_str().unwrap() },
                        "pull": { "root": pull.get_root().unwrap().to_str().unwrap(), "globs": text_list_json(pull.get_globs().unwrap()) } })
            }
            Which::AwaitStart(()) => json!({ "type": "awaitStart" }),
            Which::Signal(s) => json!({ "type": "signal", "signal": s }),
            Which::Pull(()) => json!({ "type": "pull" }),
            Which::Close(()) => json!({ "type": "close" }),
        }
    }

    fn report_into(mut b: crate::proto::exec_capnp::report::Builder, v: &Value) {
        b.set_written(v["written"].as_u64().unwrap() as u32);
        b.set_bytes(v["bytes"].as_u64().unwrap());
        let deleted = strings(&v["deleted"]);
        let mut d = b.reborrow().init_deleted(deleted.len() as u32);
        for (i, p) in deleted.iter().enumerate() {
            d.set(i as u32, p.as_str());
        }
        skipped_into(
            b.init_skipped(v["skipped"].as_array().unwrap().len() as u32),
            &v["skipped"],
        );
    }

    fn skipped_into(mut list: capnp::struct_list::Builder<crate::proto::exec_capnp::skipped::Owned>, v: &Value) {
        for (i, s) in v.as_array().unwrap().iter().enumerate() {
            let mut b = list.reborrow().get(i as u32);
            b.set_path(s["path"].as_str().unwrap());
            b.set_reason(s["reason"].as_str().unwrap());
        }
    }

    /// Encode a response from the JSON in tests/golden/responses.json.
    fn response_bytes(v: &Value) -> Vec<u8> {
        let mut message = Builder::new_default();
        let mut r = message.init_root::<response::Builder>();
        match v["type"].as_str().unwrap() {
            "begun" => {
                let mut b = r.init_begun();
                b.set_protocol(v["protocol"].as_u64().unwrap() as u16);
                b.set_version(v["version"].as_str().unwrap());
                b.set_arch(v["arch"].as_str().unwrap());
                b.set_lock_wait_ms(v["lockWaitMs"].as_u64().unwrap() as u32);
            }
            "want" => {
                let indices = v["indices"].as_array().unwrap();
                let mut l = r.init_want(indices.len() as u32);
                for (i, n) in indices.iter().enumerate() {
                    l.set(i as u32, n.as_u64().unwrap() as u32);
                }
            }
            "pushReport" => report_into(r.init_push_report(), &v["report"]),
            "prepared" => r.set_prepared(&unhex(v["token"].as_str().unwrap()).unwrap()),
            "started" => r.set_started(v["pid"].as_u64().unwrap() as u32),
            "signaled" => r.set_signaled(()),
            "changes" => {
                let mut c = r.init_changes();
                let changed = v["changed"].as_array().unwrap();
                let mut l = c.reborrow().init_changed(changed.len() as u32);
                for (i, e) in changed.iter().enumerate() {
                    write_entry(l.reborrow().get(i as u32), &entry_from(e));
                }
                let deleted = strings(&v["deleted"]);
                let mut d = c.reborrow().init_deleted(deleted.len() as u32);
                for (i, p) in deleted.iter().enumerate() {
                    d.set(i as u32, p.as_str());
                }
                skipped_into(
                    c.init_skipped(v["skipped"].as_array().unwrap().len() as u32),
                    &v["skipped"],
                );
            }
            "chunk" => {
                let mut c = r.init_chunk();
                c.set_index(v["index"].as_u64().unwrap() as u32);
                c.set_data(&unhex(v["data"].as_str().unwrap()).unwrap());
                c.set_last(v["last"].as_bool().unwrap());
            }
            "pullEnd" => report_into(r.init_pull_end(), &v["report"]),
            "error" => {
                let mut e = r.init_error();
                e.set_code(v["code"].as_str().unwrap());
                e.set_message(v["message"].as_str().unwrap());
                e.set_errno(v["errno"].as_i64().unwrap() as i32);
            }
            "closed" => r.set_closed(()),
            other => panic!("unknown response type {other}"),
        }
        to_bytes(&message)
    }

    fn golden(name: &str) -> Value {
        serde_json::from_str(&fs::read_to_string(fixtures_dir("golden").join(name)).unwrap()).unwrap()
    }

    /// Our encoding of every response in responses.json matches the committed bytes, which the
    /// TypeScript decoder is tested against. UPDATE_GOLDEN=1 rewrites them.
    #[test]
    fn golden_responses() {
        let dir = fixtures_dir("golden").join("responses");
        for case in golden("responses.json").as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let bytes = response_bytes(&case["response"]);
            let path = dir.join(format!("{name}.bin"));
            if std::env::var_os("UPDATE_GOLDEN").is_some() {
                fs::write(&path, &bytes).unwrap();
            }
            assert_eq!(
                fs::read(&path).unwrap_or_default(),
                bytes,
                "responses/{name}.bin differs (UPDATE_GOLDEN=1 to rewrite)"
            );
        }
    }

    /// Every request TypeScript encoded (requests/<name>.bin) decodes to what requests.json says.
    #[test]
    fn golden_requests() {
        let dir = fixtures_dir("golden").join("requests");
        let cases = golden("requests.json");
        for case in cases.as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let bytes = fs::read(dir.join(format!("{name}.bin"))).unwrap_or_else(|_| {
                panic!("requests/{name}.bin is missing: run UPDATE_GOLDEN=1 npm test --workspace @cloudflare/computer")
            });
            let mut slice = &bytes[..];
            let message = capnp::serialize::read_message(&mut slice, reader_options()).unwrap();
            assert!(slice.is_empty(), "{name}: trailing bytes");
            assert_eq!(
                request_json(message.get_root().unwrap()),
                case["request"],
                "requests/{name}.bin"
            );
        }
    }

    #[test]
    fn entries_round_trip() {
        for e in [
            Entry {
                path: "a/b.txt".into(),
                kind: Kind::File,
                mode: 0o755,
                size: u64::MAX,
                hash: vec![7; 32],
                target: String::new(),
            },
            Entry {
                path: "l".into(),
                kind: Kind::Symlink,
                mode: 0o777,
                size: 0,
                hash: Vec::new(),
                target: "../x".into(),
            },
        ] {
            let mut message = Builder::new_default();
            write_entry(message.init_root(), &e);
            let bytes = to_bytes(&message);
            let reader = from_bytes(&bytes).unwrap();
            assert_eq!(
                entry_json(&read_entry(reader.get_root().unwrap()).unwrap()),
                entry_json(&e)
            );
        }
    }

    #[test]
    fn decoding_garbage_fails_cleanly() {
        assert!(from_bytes(&[]).is_err());
        assert!(from_bytes(&[0xff; 7]).is_err());
        // A segment table claiming far more data than there is.
        assert!(from_bytes(&[0, 0, 0, 0, 0xff, 0xff, 0xff, 0x0f]).is_err());
    }

    #[test]
    fn globs_must_stay_relative() {
        assert!(check_globs(&["src/**".into(), "!**/*.log".into(), ".gitignore".into()]).is_ok());
        for bad in ["", "!", "/etc/**", "!/etc", "../x", "a/../../b"] {
            assert!(check_globs(&[bad.to_string()]).is_err(), "{bad:?}");
        }
    }
}
