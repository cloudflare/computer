//! Starting the command on the descriptors `run` handed over, and making sure nothing it started
//! outlives the call.

use crate::util::{parse_owner, Error, Res};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct Spec {
    pub argv: Vec<String>,
    pub cwd: String,
    /// The command's whole environment (`environment()`).
    pub env: Vec<(OsString, OsString)>,
    pub user: String,
}

/// The image's environment, in `/proc/<pid>/environ`'s format. The platform starts us with
/// little of it (on Cloudflare, `PATH` only), so it's read from PID 1, the image's entrypoint.
/// `REMOTE_EXEC_IMAGE_ENV` names another file, for tests.
pub fn image_environ() -> Res<Vec<u8>> {
    let path = std::env::var_os("REMOTE_EXEC_IMAGE_ENV")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/proc/1/environ".into());
    read_as_owner(&path).map_err(|e| Error {
        code: "io",
        message: format!("can't read the image's environment from {}: {e}", path.display()),
        errno: e.raw_os_error().unwrap_or(0),
    })
}

/// Read `path` with its owner's filesystem ids. Another user's `environ` is readable only by them
/// or with `CAP_SYS_PTRACE`, which containers rarely have, so root (us, when the image's user isn't
/// root) reads PID 1's as PID 1's user. `setfsuid` changes only this thread's ids.
fn read_as_owner(path: &Path) -> std::io::Result<Vec<u8>> {
    let meta = fs::metadata(path)?;
    let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
    if uid != 0 || (meta.uid(), meta.gid()) == (uid, gid) {
        return fs::read(path);
    }
    unsafe {
        libc::setfsgid(meta.gid());
        libc::setfsuid(meta.uid());
    }
    let read = fs::read(path);
    unsafe {
        libc::setfsuid(uid);
        libc::setfsgid(gid);
    }
    read
}

/// A command's environment, each layer over the one before: ours, for what the runtime gives
/// every process and the image doesn't set (`HOME`), without our own settings and our `PWD`;
/// the image's (`image_environ()`), as `docker exec` starts with; and the command's own.
pub fn environment(image: &[u8], given: &[(String, String)]) -> Res<Vec<(OsString, OsString)>> {
    let mut env: BTreeMap<OsString, OsString> = std::env::vars_os()
        .filter(|(name, _)| name != "PWD" && !name.as_bytes().starts_with(b"REMOTE_EXEC_"))
        .collect();
    for entry in image.split(|&b| b == 0).filter(|e| !e.is_empty()) {
        let eq = entry.iter().position(|&b| b == b'=').ok_or_else(|| {
            Error::new(
                "io",
                format!(
                    "the image's environment has an entry without '=': {:?}",
                    String::from_utf8_lossy(entry)
                ),
            )
        })?;
        env.insert(
            OsString::from_vec(entry[..eq].to_vec()),
            OsString::from_vec(entry[eq + 1..].to_vec()),
        );
    }
    env.extend(given.iter().map(|(name, value)| (name.into(), value.into())));
    Ok(env.into_iter().collect())
}

/// Start the command in its own session and process group, as `user`, on `fds` (stdin, stdout,
/// stderr). Returns its pid, which is also its process group id.
pub fn spawn(spec: &Spec, fds: [OwnedFd; 3]) -> Res<i32> {
    let program = spec.argv.first().ok_or_else(|| Error::protocol("empty argv"))?;
    let owner = parse_owner(&spec.user)?;
    let mut cmd = Command::new(program);
    cmd.args(&spec.argv[1..]);
    cmd.env_clear().envs(spec.env.iter().map(|(name, value)| (name, value)));
    if !spec.cwd.is_empty() {
        cmd.current_dir(&spec.cwd);
    }
    let [stdin, stdout, stderr] = fds;
    cmd.stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some((uid, gid)) = owner {
        // std drops supplementary groups when it changes uid as root.
        cmd.uid(uid).gid(gid);
    }
    let unprivileged = owner.is_some_and(|(uid, _)| uid != 0);
    let session = std::process::id() as libc::pid_t;
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // If the session dies, so does the command. The death signal comes from the thread
            // that forks, the session's main thread, which lives as long as the session. A session
            // that died before this call would send nothing, so check it's still our parent.
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0);
            if libc::getppid() != session {
                return Err(std::io::Error::other("the session exited"));
            }
            if unprivileged {
                drop_privileges()?;
            }
            Ok(())
        });
    }
    match cmd.spawn() {
        // Dropping `Child` neither waits nor kills; the supervisor waits with waitpid.
        Ok(child) => Ok(child.id() as i32),
        Err(e) => Err(Error {
            code: "spawn",
            message: format!("{program}: {e}"),
            errno: e.raw_os_error().unwrap_or(0),
        }),
    }
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;

/// Runs in the child after std has switched to a non-root user. Some runtimes leave the switched
/// process root's capabilities, so drop them all, and keep setuid binaries and file capabilities
/// from granting any back.
fn drop_privileges() -> std::io::Result<()> {
    let check = |r: libc::c_long| {
        if r < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    };
    unsafe {
        check(libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) as libc::c_long)?;
        let header = CapHeader {
            version: LINUX_CAPABILITY_VERSION_3,
            pid: 0,
        };
        let data = [
            CapData {
                effective: 0,
                permitted: 0,
                inheritable: 0,
            },
            CapData {
                effective: 0,
                permitted: 0,
                inheritable: 0,
            },
        ];
        check(libc::syscall(libc::SYS_capset, &header, data.as_ptr()))?;
        check(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) as libc::c_long)?;
    }
    Ok(())
}

/// Wait for `pid` and turn its status into an exit code: the code, or 128 + signal.
pub fn wait_exit(pid: i32) -> i32 {
    let mut status = 0;
    loop {
        let r = unsafe { libc::waitpid(pid, &mut status, 0) };
        if r == pid {
            break;
        }
        if r < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return 255;
        }
    }
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        255
    }
}

/// Our direct children. The session is a child subreaper, so orphaned descendants of the command
/// end up here, including ones that left its process group with setsid().
fn children() -> Vec<i32> {
    let me = std::process::id() as i32;
    let mut out = Vec::new();
    let Ok(dir) = fs::read_dir("/proc") else { return out };
    for entry in dir.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // "pid (comm) state ppid ..."; comm may contain spaces and parentheses.
        let Some(after) = stat.rfind(')').map(|i| &stat[i + 1..]) else {
            continue;
        };
        let mut fields = after.split_whitespace();
        let _state = fields.next();
        if fields.next().and_then(|p| p.parse::<i32>().ok()) == Some(me) {
            out.push(pid);
        }
    }
    out
}

/// Signal the command's process group, and with `everything`, every other process we parent.
pub fn signal_tree(pgid: i32, signal: i32, everything: bool) {
    unsafe {
        libc::killpg(pgid, signal);
    }
    if everything {
        for pid in children() {
            unsafe {
                libc::kill(pid, signal);
            }
        }
    }
}

fn reap_any() {
    loop {
        let mut status = 0;
        let r = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if r <= 0 {
            break;
        }
    }
}

fn group_alive(pgid: i32) -> bool {
    unsafe { libc::killpg(pgid, 0) == 0 }
}

/// After the command's first process exits: SIGTERM what's left, SIGKILL it after `grace`, and
/// reap everything.
pub fn terminate_rest(pgid: i32, grace: Duration) {
    signal_tree(pgid, libc::SIGTERM, true);
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        reap_any();
        if !group_alive(pgid) && children().is_empty() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    kill_all(pgid);
}

/// SIGKILL the command's group and every descendant, repeating until nothing is left: killing a
/// parent reparents its children to us, and they're killed on the next pass.
pub fn kill_all(pgid: i32) {
    for _ in 0..200 {
        signal_tree(pgid, libc::SIGKILL, true);
        std::thread::sleep(Duration::from_millis(10));
        reap_any();
        if !group_alive(pgid) && children().is_empty() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::io::Read;
    use std::os::fd::OwnedFd;
    use std::sync::Mutex;

    /// These tests start processes and some signal every child of the test process, so they run
    /// one at a time, with the test process as a subreaper (as the session is).
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        unsafe {
            libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
        }
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    struct Run {
        pid: i32,
        stdout: fs::File,
    }

    fn start(argv: &[&str], env: &[(&str, &str)], cwd: &str, user: &str) -> Res<Run> {
        start_in(b"", argv, env, cwd, user)
    }

    fn start_in(image: &[u8], argv: &[&str], env: &[(&str, &str)], cwd: &str, user: &str) -> Res<Run> {
        // CLOEXEC, as the session's descriptors are: otherwise children inherit the write end at
        // its original number and the pipe never reaches EOF.
        let (out_r, out_w) = nix::unistd::pipe2(nix::fcntl::OFlag::O_CLOEXEC).unwrap();
        let null = |write: bool| -> OwnedFd {
            fs::OpenOptions::new()
                .read(!write)
                .write(write)
                .open("/dev/null")
                .unwrap()
                .into()
        };
        let spec = Spec {
            argv: argv.iter().map(|s| s.to_string()).collect(),
            cwd: cwd.into(),
            env: environment(
                image,
                &env.iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect::<Vec<_>>(),
            )?,
            user: user.into(),
        };
        let pid = spawn(&spec, [null(false), out_w, null(true)])?;
        Ok(Run {
            pid,
            stdout: fs::File::from(out_r),
        })
    }

    fn output(mut run: Run) -> (i32, String) {
        let code = wait_exit(run.pid);
        let mut out = String::new();
        run.stdout.read_to_string(&mut out).unwrap();
        (code, out)
    }

    fn alive(pid: i32) -> bool {
        // A zombie still has /proc/<pid>; check its state too.
        fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|s| !s.contains(") Z "))
            .unwrap_or(false)
    }

    fn env_of(image: &[u8], given: &[(&str, &str)]) -> BTreeMap<String, String> {
        let given: Vec<_> = given.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        environment(image, &given)
            .unwrap()
            .into_iter()
            .map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap()))
            .collect()
    }

    #[test]
    fn the_environment_is_ours_under_the_images_under_the_commands() {
        crate::testutil::private_state();
        std::env::set_var("REMOTE_EXEC_TEST_OWN", "ours");
        let env = env_of(
            b"RUSTUP_HOME=/usr/local/rustup\0REMOTE_EXEC_TEST_OWN=image\0EMPTY=\0B=x=y\0OVERRIDDEN=image\0",
            &[("OVERRIDDEN", "command"), ("NEW", "command")],
        );
        assert_eq!(env["RUSTUP_HOME"], "/usr/local/rustup");
        assert_eq!(env["REMOTE_EXEC_TEST_OWN"], "image", "the image's wins over ours");
        assert_eq!(env["EMPTY"], "");
        assert_eq!(env["B"], "x=y");
        assert_eq!(env["OVERRIDDEN"], "command");
        assert_eq!(env["NEW"], "command");
        assert_eq!(
            env["HOME"],
            std::env::var("HOME").unwrap(),
            "ours fills in what the image lacks"
        );
        assert!(!env.contains_key("REMOTE_EXEC_STATE_DIR"), "our settings stay ours");
        assert!(!env.contains_key("PWD"));
        assert!(environment(b"A=1\0garbage\0", &[]).is_err());
    }

    #[test]
    fn reads_the_image_environment_from_the_given_file() {
        let dir = TempDir::new("environ");
        let path = dir.write("environ", "A=1\0B=2\0");
        std::env::set_var("REMOTE_EXEC_IMAGE_ENV", &path);
        assert_eq!(image_environ().unwrap(), b"A=1\0B=2\0");
        std::env::set_var("REMOTE_EXEC_IMAGE_ENV", dir.path().join("missing"));
        let e = image_environ().err().unwrap();
        assert_eq!((e.code, e.errno), ("io", libc::ENOENT));
        std::env::remove_var("REMOTE_EXEC_IMAGE_ENV");
    }

    /// Run `f` without `CAP_SYS_PTRACE` in this thread's effective set, as in a container that
    /// isn't privileged.
    fn without_ptrace<T>(f: impl FnOnce() -> T) -> T {
        const CAP_SYS_PTRACE: u32 = 19;
        let header = CapHeader {
            version: LINUX_CAPABILITY_VERSION_3,
            pid: 0,
        };
        let empty = CapData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        };
        let mut saved = [empty; 2];
        assert_eq!(
            unsafe { libc::syscall(libc::SYS_capget, &header, saved.as_mut_ptr()) },
            0
        );
        let mut reduced = saved;
        reduced[0].effective &= !(1 << CAP_SYS_PTRACE);
        assert_eq!(unsafe { libc::syscall(libc::SYS_capset, &header, reduced.as_ptr()) }, 0);
        let result = f();
        assert_eq!(unsafe { libc::syscall(libc::SYS_capset, &header, saved.as_ptr()) }, 0);
        result
    }

    #[test]
    fn root_reads_another_users_environment_as_them() {
        let _g = serial();
        let run = start(&["sleep", "10"], &[("FROM", "pid")], "/", "1234:5678").unwrap();
        let environ = PathBuf::from(format!("/proc/{}/environ", run.pid));
        let deadline = Instant::now() + Duration::from_secs(5);
        while fs::metadata(&environ).unwrap().uid() != 1234 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let (plain, read) = without_ptrace(|| (fs::read(&environ), read_as_owner(&environ)));
        assert_eq!(plain.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
        assert!(read.unwrap().split(|&b| b == 0).any(|e| e == b"FROM=pid"));
        assert_eq!(
            unsafe { (libc::setfsuid(u32::MAX), libc::setfsgid(u32::MAX)) },
            (0, 0),
            "our ids are restored"
        );
        kill_all(run.pid);
    }

    #[test]
    fn runs_with_the_image_environment_plus_the_given_one_and_cwd() {
        let _g = serial();
        let dir = TempDir::new("spawn");
        let run = start_in(
            b"CARGO_HOME=/usr/local/cargo\0FOO=image\0",
            &["sh", "-c", "echo $CARGO_HOME; echo $FOO; echo $PATH; pwd"],
            &[("FOO", "bar baz")],
            dir.path().to_str().unwrap(),
            "",
        )
        .unwrap();
        let (code, out) = output(run);
        assert_eq!(code, 0);
        let canonical = fs::canonicalize(dir.path()).unwrap();
        let path = std::env::var("PATH").unwrap();
        assert_eq!(
            out,
            format!("/usr/local/cargo\nbar baz\n{path}\n{}\n", canonical.display())
        );
    }

    #[test]
    fn the_given_environment_wins() {
        let _g = serial();
        let (_, out) = output(
            start_in(
                b"PATH=/image/bin:/bin\0",
                &["/bin/sh", "-c", "echo $PATH"],
                &[("PATH", "/custom/bin:/bin")],
                "",
                "",
            )
            .unwrap(),
        );
        assert_eq!(out, "/custom/bin:/bin\n");
    }

    #[test]
    fn reports_spawn_failures_with_errno() {
        let _g = serial();
        let e = start(&["/definitely/not/here"], &[], "", "").err().unwrap();
        assert_eq!((e.code, e.errno), ("spawn", libc::ENOENT));
        let e = start(&["true"], &[], "/no/such/dir", "").err().unwrap();
        assert_eq!(e.code, "spawn");
        assert!(
            start(&["true"], &[], "", "nobody").is_err(),
            "a non-numeric user is refused"
        );
        assert!(
            spawn(
                &Spec {
                    argv: vec![],
                    cwd: String::new(),
                    env: vec![],
                    user: String::new()
                },
                [
                    fs::File::open("/dev/null").unwrap().into(),
                    fs::File::open("/dev/null").unwrap().into(),
                    fs::File::open("/dev/null").unwrap().into(),
                ]
            )
            .is_err(),
            "empty argv"
        );
    }

    #[test]
    fn exit_codes_and_signals() {
        let _g = serial();
        assert_eq!(output(start(&["sh", "-c", "exit 3"], &[], "", "").unwrap()).0, 3);
        assert_eq!(
            output(start(&["sh", "-c", "kill -TERM $$"], &[], "", "").unwrap()).0,
            128 + libc::SIGTERM
        );
        assert_eq!(
            output(start(&["sh", "-c", "kill -KILL $$"], &[], "", "").unwrap()).0,
            128 + libc::SIGKILL
        );
    }

    #[test]
    fn starts_a_new_session_and_process_group() {
        let _g = serial();
        let run = start(&["sh", "-c", "cut -d' ' -f5,6 /proc/$$/stat"], &[], "", "").unwrap();
        let pid = run.pid;
        let (_, out) = output(run);
        assert_eq!(out.trim(), format!("{pid} {pid}"), "pgid and sid are the command's pid");
    }

    #[test]
    fn drops_to_the_given_user() {
        let _g = serial();
        let (code, out) = output(start(&["sh", "-c", "id -u; id -g; id -G"], &[], "/", "1234:5678").unwrap());
        assert_eq!(code, 0);
        assert_eq!(out, "1234\n5678\n5678\n", "no supplementary groups kept");
    }

    #[test]
    fn an_unprivileged_user_keeps_no_capabilities() {
        let _g = serial();
        let (code, out) = output(
            start(
                &[
                    "sh",
                    "-c",
                    "grep -E '^(Cap(Inh|Prm|Eff|Amb)|NoNewPrivs):' /proc/self/status",
                ],
                &[],
                "/",
                "1234:5678",
            )
            .unwrap(),
        );
        assert_eq!(code, 0);
        let fields: Vec<(&str, &str)> = out
            .lines()
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k, v.trim()))
            .collect();
        assert_eq!(
            fields,
            [
                ("CapInh", "0000000000000000"),
                ("CapPrm", "0000000000000000"),
                ("CapEff", "0000000000000000"),
                ("CapAmb", "0000000000000000"),
                ("NoNewPrivs", "1"),
            ]
        );
    }

    #[test]
    fn signal_tree_reaches_the_whole_group() {
        let _g = serial();
        let run = start(&["sh", "-c", "sleep 100 >/dev/null & echo $!; wait"], &[], "", "").unwrap();
        let mut first = [0u8; 32];
        let mut stdout = run.stdout.try_clone().unwrap();
        let n = stdout.read(&mut first).unwrap();
        let child: i32 = String::from_utf8_lossy(&first[..n]).trim().parse().unwrap();
        signal_tree(run.pid, libc::SIGTERM, false);
        assert_eq!(wait_exit(run.pid), 128 + libc::SIGTERM);
        terminate_rest(run.pid, Duration::from_secs(2));
        assert!(!alive(child));
    }

    #[test]
    fn terminate_rest_ends_processes_that_left_the_group() {
        let _g = serial();
        // A daemon that calls setsid() leaves the group; when its parent exits it's reparented to
        // us (the subreaper) and must still be stopped.
        let run = start(
            &[
                "sh",
                "-c",
                "setsid sh -c 'trap \"\" TERM; sleep 100' >/dev/null & echo $!",
            ],
            &[],
            "",
            "",
        )
        .unwrap();
        let pid = run.pid;
        let (code, out) = output(run);
        assert_eq!(code, 0);
        let daemon: i32 = out.trim().parse().unwrap();
        // Wait until its trap is installed, or SIGTERM would end it straight away.
        let ignores_term = || {
            fs::read_to_string(format!("/proc/{daemon}/status"))
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|l| l.starts_with("SigIgn:"))
                        .map(|l| l[7..].trim().to_string())
                })
                .and_then(|mask| u64::from_str_radix(&mask, 16).ok())
                .is_some_and(|mask| mask & (1 << (libc::SIGTERM - 1)) != 0)
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ignores_term() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(alive(daemon) && ignores_term());
        let started = Instant::now();
        terminate_rest(pid, Duration::from_millis(300));
        assert!(!alive(daemon), "SIGKILLed after ignoring SIGTERM");
        assert!(
            started.elapsed() >= Duration::from_millis(300),
            "waited the grace period first"
        );
        assert!(children().is_empty());
    }

    #[test]
    fn kill_all_is_immediate() {
        let _g = serial();
        let run = start(&["sh", "-c", "trap '' TERM; sleep 100 & sleep 100 & wait"], &[], "", "").unwrap();
        std::thread::sleep(Duration::from_millis(100));
        kill_all(run.pid);
        assert!(!alive(run.pid));
        assert!(children().is_empty());
    }
}
