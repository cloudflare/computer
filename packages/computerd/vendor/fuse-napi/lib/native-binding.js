const fs = require('fs')
const path = require('path')

const loadDefaultBinding = require('node-gyp-build')

function loadNativeBinding (root, dependencies = {}) {
  const platform = dependencies.platform || process.platform
  const arch = dependencies.arch || process.arch
  const abi = dependencies.abi || process.versions.modules
  const exists = dependencies.exists || fs.existsSync
  const loadDefault = dependencies.loadDefault || loadDefaultBinding
  const loadFile = dependencies.loadFile || require

  if (platform !== 'linux') return loadDefault(root)

  /*
   * A local source build is linked to the host's installed libfuse ABI and
   * must take precedence over bundled release artifacts.
   */
  if (exists(path.join(root, 'build', 'Release', 'fuse.node')) ||
      exists(path.join(root, 'build', 'Debug', 'fuse.node'))) {
    return loadDefault(root)
  }

  const libc = dependencies.libc || process.env.LIBC ||
    (exists('/etc/alpine-release') ? 'musl' : 'glibc')

  /*
   * libfuse 3.18 moved from SONAME libfuse3.so.3 to libfuse3.so.4 when statx
   * was added to the high-level API. Keep the glibc/libfuse 3.10 baseline and
   * select an explicitly tagged musl artifact on Alpine, while preferring the
   * modern ABI when the matching release artifact and runtime are present.
   */
  const modernPrebuild = path.join(
    root,
    'prebuilds',
    `linux-${arch}-fuse4`,
    `fuse-napi.abi${abi}${libc === 'musl' ? '.musl' : ''}.node`
  )
  if (exists(modernPrebuild)) {
    try {
      return loadFile(modernPrebuild)
    } catch (error) {
      if (!isMissingSharedLibrary(error, 'libfuse3.so.4')) throw error
    }
  }

  try {
    return loadDefault(root)
  } catch (error) {
    throw wrapLinuxFuseLoadError(error, modernPrebuild, exists(modernPrebuild))
  }
}

function wrapLinuxFuseLoadError (error, modernPrebuild, hasModernPrebuild) {
  if (!isMissingSharedLibrary(error, 'libfuse3.so.3') &&
      !isMissingSharedLibrary(error, 'libfuse3.so.4')) {
    return error
  }

  const wrapped = new Error(
    'fuse-napi requires a supported FUSE 3 runtime. Install libfuse 3.10.3 or ' +
    'newer plus fusermount3 (Alpine: apk add fuse3; Debian/Ubuntu: ' +
    'sudo apt-get install fuse3 libfuse3-3).'
  )
  wrapped.code = 'EFUSEDEPENDENCY'
  wrapped.cause = error
  if (!hasModernPrebuild) wrapped.missingPrebuild = modernPrebuild
  return wrapped
}

function isMissingSharedLibrary (error, library) {
  return !!error && typeof error.message === 'string' && error.message.includes(library)
}

module.exports = {
  loadNativeBinding,
  wrapLinuxFuseLoadError
}
