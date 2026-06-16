Every file and directory on the `wsd` FUSE mount reports zero disk usage. Writing twelve bytes and asking `du` for the size returns `0`:

```sh
printf 'hello world\n' > /workspace/du-repro.txt
stat -c 'size=%s blocks=%b' /workspace/du-repro.txt
# size=12 blocks=0
du -B1 /workspace/du-repro.txt
# 0	/workspace/du-repro.txt
```

This is not a `du` bug. `du` reads `st_blocks` from `stat(2)`, not `st_size`, and the FUSE driver was leaving `st_blocks` empty. The `getattr` path built its stat result without the `blocks` and `blksize` fields, so the kernel saw zero allocated blocks for every inode on the mount.

The fix populates both fields wherever the driver builds a stat. `st_blocks` counts allocation in fixed 512-byte units, the unit POSIX defines for that field regardless of the filesystem's logical block size, so a 513-byte file occupies two blocks and an empty file occupies none. `st_blksize` is the preferred input/output size, a separate value that stays at `4096` to match what `statfs` already advertises and what the backing virtual filesystem reports. The backing filesystem already supplies both fields for files written to disk, so the driver passes those through and only derives the values for the in-memory cases: a freshly created file before its first flush, and a file whose buffered size has outrun the size on disk.

Reviewers with a privileged FUSE-capable container can verify the behavior against a real mount:

```sh
printf 'hello world\n' > /workspace/du-repro.txt
stat -c 'size=%s blocks=%b' /workspace/du-repro.txt
# size=12 blocks=1
du -B1 /workspace/du-repro.txt
# 512	/workspace/du-repro.txt
```

The regression tests cover the same block accounting without requiring a mount. They assert block counts for a 513-byte file, an empty file, a freshly created file that has not flushed, and a file whose buffered size has grown past a block boundary before flush. These tests fail against the old stat shape because `blocks` and `blksize` are missing, and pass with this change.

This also updates the setup documentation around running the tests from a clean container. `AGENTS.md` now calls out the native build tools `fuse-native` needs, the Linux arm64 libfuse swap needed when the package's bundled x64 library cannot link, the need to build sibling package output before running tests, and the different gates used by the two real-FUSE test suites. The `packages/wsd` README no longer claims that its test script builds first or uses Node's type stripping; it describes the Vitest command, the required build output, and the difference between the `/dev/fuse`-guarded CLI test and the Docker-backed real-FUSE runner test.
