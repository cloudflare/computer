//! The run ↔ session socket: SOCK_SEQPACKET, one Cap'n Proto message per packet, with the run's
//! stdio passed as SCM_RIGHTS on `attach`.

use crate::util::{Error, Res};
use nix::sys::socket::{
    bind, connect, listen, recvmsg, sendmsg, socket, AddressFamily, Backlog, ControlMessage, ControlMessageOwned,
    MsgFlags, SockFlag, SockType, UnixAddr,
};
use std::io::{IoSlice, IoSliceMut};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;

pub const MAX_PACKET: usize = 64 * 1024;

pub fn listen_at(path: &Path) -> Res<OwnedFd> {
    let _ = std::fs::remove_file(path);
    let fd = socket(AddressFamily::Unix, SockType::SeqPacket, SockFlag::SOCK_CLOEXEC, None)?;
    bind(fd.as_raw_fd(), &UnixAddr::new(path)?)?;
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    listen(&fd, Backlog::new(4)?)?;
    Ok(fd)
}

pub fn connect_to(path: &Path) -> Res<OwnedFd> {
    let fd = socket(AddressFamily::Unix, SockType::SeqPacket, SockFlag::SOCK_CLOEXEC, None)?;
    connect(fd.as_raw_fd(), &UnixAddr::new(path)?)?;
    Ok(fd)
}

pub fn accept_within(listener: &OwnedFd, timeout_ms: i32) -> Res<OwnedFd> {
    let mut pfd = libc::pollfd {
        fd: listener.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms as u64);
    // poll() is never restarted after a signal handler runs, and the process gets SIGCHLD.
    loop {
        let left = deadline
            .saturating_duration_since(std::time::Instant::now())
            .as_millis() as i32;
        let r = unsafe { libc::poll(&mut pfd, 1, left) };
        if r == 0 {
            return Err(Error::new("attach-timeout", "no `remote-exec run` attached in time"));
        }
        if r > 0 {
            break;
        }
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::Interrupted {
            return Err(e.into());
        }
    }
    let fd = unsafe {
        libc::accept4(
            listener.as_raw_fd(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            libc::SOCK_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn send(fd: RawFd, bytes: &[u8], fds: &[RawFd]) -> Res<()> {
    let iov = [IoSlice::new(bytes)];
    if fds.is_empty() {
        sendmsg::<()>(fd, &iov, &[], MsgFlags::MSG_NOSIGNAL, None)?;
    } else {
        sendmsg::<()>(
            fd,
            &iov,
            &[ControlMessage::ScmRights(fds)],
            MsgFlags::MSG_NOSIGNAL,
            None,
        )?;
    }
    Ok(())
}

/// One packet and any descriptors it carried. An empty packet means the peer closed.
pub fn recv(fd: RawFd) -> Res<(Vec<u8>, Vec<OwnedFd>)> {
    let mut buf = vec![0u8; MAX_PACKET];
    let mut space = nix::cmsg_space!([RawFd; 3]);
    let (bytes, fds) = {
        let mut iov = [IoSliceMut::new(&mut buf)];
        let msg = recvmsg::<()>(fd, &mut iov, Some(&mut space), MsgFlags::MSG_CMSG_CLOEXEC)?;
        let mut fds = Vec::new();
        for cmsg in msg.cmsgs()? {
            if let ControlMessageOwned::ScmRights(received) = cmsg {
                fds.extend(received.into_iter().map(|f| unsafe { OwnedFd::from_raw_fd(f) }));
            }
        }
        (msg.bytes, fds)
    };
    buf.truncate(bytes);
    Ok((buf, fds))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn passes_descriptors_and_messages() {
        let dir = TempDir::new("sock");
        let path = dir.path().join("s.sock");
        let listener = listen_at(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let client = connect_to(&path).unwrap();
        let server = accept_within(&listener, 1000).unwrap();

        let (r, w) = nix::unistd::pipe().unwrap();
        send(client.as_raw_fd(), b"hello", &[w.as_raw_fd()]).unwrap();
        drop(w);
        let (bytes, fds) = recv(server.as_raw_fd()).unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(fds.len(), 1);
        let mut received = std::fs::File::from(fds.into_iter().next().unwrap());
        received.write_all(b"through the passed fd").unwrap();
        drop(received);
        let mut out = String::new();
        std::fs::File::from(r).read_to_string(&mut out).unwrap();
        assert_eq!(out, "through the passed fd");

        // Packets keep their boundaries; a closed peer reads as an empty packet.
        send(server.as_raw_fd(), b"one", &[]).unwrap();
        send(server.as_raw_fd(), b"two", &[]).unwrap();
        assert_eq!(recv(client.as_raw_fd()).unwrap().0, b"one");
        assert_eq!(recv(client.as_raw_fd()).unwrap().0, b"two");
        drop(server);
        assert!(recv(client.as_raw_fd()).unwrap().0.is_empty());
    }

    #[test]
    fn accept_times_out() {
        let dir = TempDir::new("sock-timeout");
        let listener = listen_at(&dir.path().join("t.sock")).unwrap();
        let started = std::time::Instant::now();
        let e = accept_within(&listener, 100).err().unwrap();
        assert_eq!(e.code, "attach-timeout");
        assert!(started.elapsed() >= std::time::Duration::from_millis(90));
    }

    #[test]
    fn listening_replaces_a_stale_socket_and_connecting_to_nothing_fails() {
        let dir = TempDir::new("sock-stale");
        let path = dir.path().join("x.sock");
        drop(listen_at(&path).unwrap());
        let _again = listen_at(&path).unwrap();
        assert!(connect_to(&dir.path().join("missing.sock")).is_err());
    }
}
