#!/usr/bin/env bash
# Probe whether a container can give one command a read-only view of the mount point.
#
# Answers a single question: can `writable: false` be enforced
# preventively on the container backend, the way it already is on the
# two Dynamic Worker backends?
#
# Those backends hold no files. Every write is an RPC into the
# workspace, so a command without write access is handed a filesystem
# handle built without the capability and the write fails where it
# happens. A container has its own copy of the files and has already
# written to them by the time the host hears about the change, so the
# only move left is to refuse the change on the way back — which
# leaves the container's copy disagreeing with the workspace.
#
# A read-only bind mount inside a private mount namespace would close
# that gap: the kernel refuses the write before it reaches the
# filesystem, so nothing lands and there is nothing to refuse later.
# It is the same shape as the two filesystem handles over one store,
# with the kernel holding the capability instead of a JS object.
#
# That hinges on whether the container may create a mount namespace at
# all, which is a property of the runtime rather than of this repo.
# This script asks, and prints one of three verdicts:
#
#   USERNS      works unprivileged. Nothing to negotiate.
#   CAP_SYS_ADMIN  works, but depends on that capability being granted.
#   UNAVAILABLE neither route works. Preventive enforcement is out;
#               the after-the-fact refusal is the honest answer.
#
# Run it inside a *deployed* container. Local Docker is more
# permissive than the production sandbox and will report a pass that
# does not hold in production.
#
# Usage:  ./container-mount-probe.sh [mount-point]      (default /workspace)

set -uo pipefail

MOUNT_POINT="${1:-/workspace}"
PROBE_DIR="${MOUNT_POINT}/.mount-probe.$$"

pass() { printf '  \033[32mok\033[0m    %s\n' "$1"; }
fail() { printf '  \033[31mno\033[0m    %s\n' "$1"; }
info() { printf '        %s\n' "$1"; }

cleanup() { rm -rf "${PROBE_DIR}" 2>/dev/null; }
trap cleanup EXIT

echo
echo "container mount probe — ${MOUNT_POINT}"
echo

# ---------------------------------------------------------------
# Preconditions. A probe that cannot write in the first place would
# report every refusal below as a success.
# ---------------------------------------------------------------
echo "preconditions"

if [ ! -d "${MOUNT_POINT}" ]; then
  fail "${MOUNT_POINT} does not exist — pass the mount point as \$1"
  exit 2
fi
pass "${MOUNT_POINT} exists"

if ! mkdir -p "${PROBE_DIR}" 2>/dev/null; then
  fail "cannot write to ${MOUNT_POINT}; every refusal below would be a false pass"
  exit 2
fi
pass "${MOUNT_POINT} is writable, so a refusal below means something"

for tool in unshare mount; do
  if command -v "${tool}" >/dev/null 2>&1; then
    pass "${tool} present"
  else
    fail "${tool} missing — install util-linux in the image before trusting this result"
  fi
done
echo

# ---------------------------------------------------------------
# The two routes to a private mount namespace.
#
# Each runs in its own process so a failure to mount is distinguished
# from a mount that succeeded and then failed to refuse the write.
# The distinction matters: the first is "not allowed to try", the
# second would be a kernel bug.
# ---------------------------------------------------------------
echo "route A — unprivileged user namespace (unshare -Urm)"

a_mount=0
a_refused=0
if unshare -Urm true 2>/dev/null; then
  pass "namespace created"
  a_mount=1
  if unshare -Urm sh -c \
      "mount --bind -o ro '${MOUNT_POINT}' '${MOUNT_POINT}' 2>/dev/null" 2>/dev/null; then
    pass "bind mount accepted"
    if unshare -Urm sh -c \
        "mount --bind -o ro '${MOUNT_POINT}' '${MOUNT_POINT}' && touch '${PROBE_DIR}/a' 2>/dev/null" \
        2>/dev/null; then
      fail "write SUCCEEDED through a read-only bind mount — the mount is not doing its job"
    else
      pass "write refused"
      a_refused=1
    fi
  else
    fail "bind mount rejected"
    a_mount=0
  fi
else
  fail "cannot create a user namespace"
fi
echo

echo "route B — mount namespace only (unshare -m, needs CAP_SYS_ADMIN)"

b_refused=0
if unshare -m true 2>/dev/null; then
  pass "namespace created"
  if unshare -m sh -c \
      "mount --bind -o ro '${MOUNT_POINT}' '${MOUNT_POINT}' && touch '${PROBE_DIR}/b' 2>/dev/null" \
      2>/dev/null; then
    fail "write SUCCEEDED through a read-only bind mount — the mount is not doing its job"
  else
    # Distinguish "mounted and refused" from "never mounted".
    if unshare -m sh -c \
        "mount --bind -o ro '${MOUNT_POINT}' '${MOUNT_POINT}' 2>/dev/null" 2>/dev/null; then
      pass "write refused"
      b_refused=1
    else
      fail "bind mount rejected"
    fi
  fi
else
  fail "cannot create a mount namespace"
fi
echo

# ---------------------------------------------------------------
# Isolation. A read-only view that leaks past the one command is
# worse than none: it would let a read-only command disarm a writable
# one running beside it, which is the property the per-command
# capability exists to guarantee.
# ---------------------------------------------------------------
echo "isolation — does the read-only view stay inside its own command?"

if [ "${a_mount}" = "1" ] || [ "${b_refused}" = "1" ]; then
  if touch "${PROBE_DIR}/outer" 2>/dev/null; then
    pass "the calling shell can still write; the namespace did not leak"
    rm -f "${PROBE_DIR}/outer"
  else
    fail "the calling shell LOST write access — a read-only command would disarm its neighbours"
  fi
else
  info "skipped; no route produced a mount"
fi
echo

# ---------------------------------------------------------------
# Context for whoever reads the transcript later.
# ---------------------------------------------------------------
echo "environment"
info "kernel:  $(uname -sr 2>/dev/null || echo unknown)"
info "uid:     $(id -u 2>/dev/null || echo unknown)"

caps="$(awk '/^CapEff/{print $2}' /proc/self/status 2>/dev/null)"
if [ -n "${caps}" ]; then
  if command -v capsh >/dev/null 2>&1; then
    info "capeff:  $(capsh --decode="${caps}" 2>/dev/null | head -1)"
  else
    info "capeff:  ${caps} (install libcap2-bin for capsh --decode)"
  fi
fi

userns_max="$(sysctl -n user.max_user_namespaces 2>/dev/null)"
[ -n "${userns_max}" ] && info "user.max_user_namespaces: ${userns_max}"

clone_knob="$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)"
[ -n "${clone_knob}" ] && info "unprivileged_userns_clone: ${clone_knob}"

if [ -r /proc/self/mountinfo ]; then
  info "mount at ${MOUNT_POINT}:"
  awk -v m="${MOUNT_POINT}" '$5 == m {print "          " $0}' /proc/self/mountinfo 2>/dev/null | head -3
fi
echo

# ---------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------
echo "verdict"
if [ "${a_refused}" = "1" ]; then
  echo "  USERNS — preventive enforcement is available with no special privileges."
  echo "  Wrap a read-only exec in: unshare -Urm sh -c 'mount --bind -o ro ... && <cmd>'"
  exit 0
elif [ "${b_refused}" = "1" ]; then
  echo "  CAP_SYS_ADMIN — preventive enforcement works, but only while that"
  echo "  capability is granted. Confirm it is guaranteed before depending on it;"
  echo "  a capability that silently disappears would turn enforcement off."
  exit 0
else
  echo "  UNAVAILABLE — the container cannot build a private read-only view."
  echo "  Do not reach for a fuse-native fork to work around this: attributing a"
  echo "  FUSE request to an exec is racy, and a capability that is only usually"
  echo "  enforced is worse than an honest refusal on write-back. Keep the"
  echo "  after-the-fact refusal and make it louder instead."
  exit 1
fi
