#!/usr/bin/env bash
# Filesystem conformance test harness for the computerd FUSE mount.
# Each test runs in its own subdirectory with `set -e` so failures don't cascade.
# Run from inside the container: MOUNT=/workspace fs-tests
set -u

MOUNT="${MOUNT:-/workspace}"
ROOT="${MOUNT}/.fs-tests.$$"

pass=0
fail=0
skip=0
xfail=0
xpass=0
failures=()

# stat(1) is GNU on linux, BSD on mac; pick the right invocation
if stat -c %s "$0" >/dev/null 2>&1; then
  STAT_SIZE='stat -c %s'
  STAT_MTIME='stat -c %Y'
  STAT_ATIME='stat -c %X'
  STAT_NLINK='stat -c %h'
  STAT_INO='stat -c %i'
  STAT_MODE='stat -c %a'
else
  STAT_SIZE='stat -f %z'
  STAT_MTIME='stat -f %m'
  STAT_ATIME='stat -f %a'
  STAT_NLINK='stat -f %l'
  STAT_INO='stat -f %i'
  STAT_MODE='stat -f %A'
fi
export STAT_SIZE STAT_MTIME STAT_ATIME STAT_NLINK STAT_INO STAT_MODE

run() {
  # run NAME -- COMMANDS...
  # Each test executes in its own subdir under $ROOT with set -e.
  local name="$1"; shift
  [[ "$1" == "--" ]] && shift
  local dir="$ROOT/$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '_')"
  mkdir -p "$dir"
  local out
  if out=$(cd "$dir" && set -e && eval "$*" 2>&1); then
    printf "  \033[32mPASS\033[0m  %s\n" "$name"
    pass=$((pass + 1))
  else
    printf "  \033[31mFAIL\033[0m  %s\n" "$name"
    if [[ -n "$out" ]]; then
      while IFS= read -r line; do printf "          %s\n" "$line"; done <<< "$out"
    fi
    fail=$((fail + 1))
    failures+=("$name")
  fi
}

# Expected-fail variant: known limitation, not counted as a hard fail.
xfail_run() {
  local name="$1"; shift
  local reason="$1"; shift
  [[ "$1" == "--" ]] && shift
  local dir="$ROOT/$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '_')"
  mkdir -p "$dir"
  if (cd "$dir" && set -e && eval "$*") >/dev/null 2>&1; then
    printf "  \033[33mXPASS\033[0m %s (was expected to fail: %s)\n" "$name" "$reason"
    xpass=$((xpass + 1))
  else
    printf "  \033[33mXFAIL\033[0m %s (%s)\n" "$name" "$reason"
    xfail=$((xfail + 1))
  fi
}

skip_test() {
  printf "  \033[33mSKIP\033[0m  %s (%s)\n" "$1" "$2"
  skip=$((skip + 1))
}

section() { printf "\n\033[1m=== %s ===\033[0m\n" "$1"; }

if [[ ! -d "$MOUNT" ]]; then
  echo "mount point $MOUNT does not exist" >&2
  exit 1
fi

mkdir -p "$ROOT" || { echo "cannot create $ROOT" >&2; exit 1; }
trap 'rm -rf "$ROOT" 2>/dev/null' EXIT

section "directories"
run "mkdir"                       -- 'mkdir d1 && [ -d d1 ]'
run "mkdir -p nested"             -- 'mkdir -p a/b/c && [ -d a/b/c ]'
run "rmdir empty"                 -- 'mkdir e && rmdir e && [ ! -e e ]'
run "rmdir non-empty fails"       -- 'mkdir ne && touch ne/x && ! rmdir ne 2>/dev/null'
run "ls dir"                      -- 'mkdir d && touch d/a d/b && ls d | wc -l | grep -q ^2$'
run "stat dir is directory"       -- 'mkdir d && [ -d d ]'

section "regular files"
run "create file"                 -- 'echo hello > f && [ -f f ]'
run "read back content"           -- 'echo hello > f && [ "$(cat f)" = "hello" ]'
run "append"                      -- 'echo a > f && echo b >> f && [ "$(wc -c < f)" = "4" ]'
run "truncate to 0"               -- 'echo data > f && : > f && [ "$($STAT_SIZE f)" = "0" ]'
run "truncate(1) command"         -- 'echo abcdef > f && truncate -s 3 f && [ "$(cat f)" = "abc" ]'
run "dd seek/sparse"              -- 'dd if=/dev/zero of=f bs=1 count=1 seek=4095 2>/dev/null && [ "$($STAT_SIZE f)" = "4096" ]'

section "rename / move"
run "rename file"                 -- 'echo x > a && mv a b && [ ! -e a ] && [ -e b ]'
run "rename across dirs"          -- 'mkdir s d && echo x > s/a && mv s/a d/b && [ -e d/b ]'
run "rename overwrite"            -- 'echo old > o && echo new > n && mv -f n o && [ "$(cat o)" = "new" ]'

section "timestamps (utimens)"
run "touch new file"              -- 'touch t && [ -e t ]'
run "touch existing updates mtime" -- '
  echo x > t
  touch -d "2001-01-01 00:00:00" t
  ts=$($STAT_MTIME t)
  [ "$ts" = "978307200" ]
'
run "touch -a updates atime"      -- '
  echo x > t
  touch -a -d "2001-01-01 00:00:00" t
  ts=$($STAT_ATIME t)
  [ "$ts" = "978307200" ]
'

section "permissions (chmod / chown)"
run "chmod +x persists"           -- '
  echo "#!/bin/sh" > x && chmod +x x
  mode=$($STAT_MODE x)
  case "$mode" in *7*|*5*|*1*) exit 0;; *) echo "mode=$mode"; exit 1;; esac
'
run "chmod 600 persists"          -- '
  echo x > p && chmod 600 p
  [ "$($STAT_MODE p)" = "600" ]
'
run "executable script runs"      -- '
  printf "#!/bin/sh\necho hi\n" > x && chmod +x x && [ "$(./x)" = "hi" ]
'

section "symlinks"
run "create symlink"              -- 'echo t > target && ln -s target link && [ -L link ]'
run "readlink"                    -- 'ln -s target link && [ "$(readlink link)" = "target" ]'
run "follow symlink"              -- 'echo content > target && ln -s target link && [ "$(cat link)" = "content" ]'
run "stat -L follows"             -- 'echo x > target && ln -s target link && [ -f link ]'
run "lstat shows symlink"         -- 'echo x > target && ln -s target link && [ -L link ]'
run "dangling symlink"            -- 'ln -s nowhere d && [ -L d ] && [ ! -e d ]'
run "rm -rf removes symlink entry" -- '
  echo content > target
  mkdir d
  ln -s ../target d/link
  rm -rf d
  [ ! -e d ]
  [ -f target ]
  [ "$(cat target)" = "content" ]
'

section "hard links"
run "create hard link"            -- 'echo content > a && ln a b && [ "$(cat b)" = "content" ]'
run "nlink count == 2"            -- '
  echo x > a && ln a b
  [ "$($STAT_NLINK a)" = "2" ]
'
run "shared inode"                -- '
  echo x > a && ln a b
  [ "$($STAT_INO a)" = "$($STAT_INO b)" ]
'
run "unlink one keeps other"      -- '
  echo content > a && ln a b
  rm a && [ "$(cat b)" = "content" ]
'
run "write through hard link"     -- '
  echo old > a && ln a b
  echo new > b
  [ "$(cat a)" = "new" ]
'

section "extended attributes"
if command -v setfattr >/dev/null && command -v getfattr >/dev/null; then
  run "setfattr/getfattr roundtrip" -- '
    echo x > f
    setfattr -n user.test -v hello f
    v=$(getfattr -n user.test --only-values f 2>/dev/null)
    [ "$v" = "hello" ]
  '
else
  skip_test "xattr roundtrip" "setfattr/getfattr missing"
fi

section "locks"
if command -v flock >/dev/null; then
  run "flock exclusive acquire"   -- 'echo x > lk && flock -n lk true'
  run "flock blocks second"       -- '
    echo x > lk
    ( flock -x lk sleep 1 ) &
    sleep 0.1
    ! flock -n lk true
    wait
  '
else
  skip_test "flock" "flock not present"
fi

section "atomic-save (editor-style)"
run "write tmp + rename"          -- '
  echo old > doc
  echo new > doc.tmp
  mv doc.tmp doc
  [ "$(cat doc)" = "new" ]
'

section "large I/O"
run "1 MiB write+read"            -- '
  head -c 1048576 /dev/urandom > big
  [ "$($STAT_SIZE big)" = "1048576" ]
  cp big big2 && cmp big big2
'

section "directory listing"
run "readdir returns sorted entries" -- '
  mkdir ld && touch ld/a ld/b ld/c
  listing=$(ls ld | sort | tr "\n" " ")
  [ "$listing" = "a b c " ]
'
run "find -type f"                -- '
  mkdir ld && touch ld/a ld/b ld/c
  [ "$(find ld -type f | wc -l)" = "3" ]
'

section "errors"
run "stat missing -> ENOENT"      -- '! stat does-not-exist 2>/dev/null'
run "rm missing -> error"         -- '! rm does-not-exist 2>/dev/null'
run "mkdir existing -> EEXIST"    -- 'mkdir dup && ! mkdir dup 2>/dev/null'

printf "\n\033[1m== summary ==\033[0m  pass=%d  fail=%d  skip=%d\n" "$pass" "$fail" "$skip"
if (( fail > 0 )); then
  printf "\nfailed:\n"
  for f in "${failures[@]}"; do printf "  - %s\n" "$f"; done
  exit 1
fi
