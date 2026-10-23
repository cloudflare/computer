#!/usr/bin/env node

const fs = require('fs')
const { spawnSync } = require('child_process')

const { MACFUSE_URL } = require('../lib/macfuse')

const MINIMUM_LIBFUSE3_VERSION = [3, 10, 3]

if (require.main === module) {
  try {
    const config = discover()
    switch (process.argv[2]) {
      case 'include-dirs':
        console.log(config.includeDirs.join(' '))
        break
      case 'libraries':
        console.log(config.libraries.join(' '))
        break
      default:
        throw new Error('Usage: fuse-config.js <include-dirs|libraries>')
    }
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  }
}

function discover (
  platform = process.platform,
  pkgConfig = runPkgConfig,
  exists = fs.existsSync
) {
  const version = pkgConfig(['--modversion', 'fuse3'])
  if (version !== null) {
    const normalizedVersion = version.trim()
    if (!isSupportedVersion(normalizedVersion)) {
      throw new Error(
        `Unsupported libfuse3 version ${normalizedVersion || '(empty)'}. ` +
        `fuse-napi requires libfuse >=${MINIMUM_LIBFUSE3_VERSION.join('.')}.`
      )
    }

    const cflags = pkgConfig(['--cflags-only-I', 'fuse3'])
    const libraries = pkgConfig(['--libs', 'fuse3'])
    if (cflags !== null && libraries !== null) {
      return {
        includeDirs: words(cflags).map(flag => flag.replace(/^-I/, '')),
        libraries: words(libraries)
      }
    }
  }

  if (platform === 'darwin') {
    const include = '/usr/local/include/fuse3'
    const dylibs = [
      '/usr/local/lib/libfuse3.dylib',
      '/usr/local/lib/libfuse3.4.dylib'
    ]
    if (exists(`${include}/fuse.h`) && dylibs.some(exists)) {
      return {
        includeDirs: [include],
        libraries: ['-L/usr/local/lib', '-lfuse3', '-pthread']
      }
    }

    throw new Error(
      'macFUSE 5.3.1 or newer with its libfuse3 headers is required to build fuse-napi on macOS. ' +
      `Install macFUSE from ${MACFUSE_URL}; fuse-napi does not download or install it.`
    )
  }

  if (platform === 'linux') {
    throw new Error(
      'System libfuse3 development files, the FUSE 3 mount helper, and pkg-config are required to build fuse-napi on Linux. ' +
      'On Alpine, run: apk add build-base fuse3 fuse3-dev linux-headers pkgconf python3. ' +
      'On Debian or Ubuntu, run: sudo apt-get install libfuse3-dev fuse3 pkg-config'
    )
  }

  throw new Error(`fuse-napi supports Linux and macOS; received unsupported platform ${platform}.`)
}

function runPkgConfig (args) {
  const result = spawnSync(process.env.PKG_CONFIG || 'pkg-config', args, {
    encoding: 'utf8'
  })
  if (result.error || result.status !== 0) return null
  return result.stdout.trim()
}

function words (value) {
  return value.trim() ? value.trim().split(/\s+/) : []
}

function isSupportedVersion (version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[.-].*)?$/.exec(version)
  if (!match) return false

  const actual = match.slice(1).map(Number)
  for (let i = 0; i < MINIMUM_LIBFUSE3_VERSION.length; i++) {
    if (actual[i] > MINIMUM_LIBFUSE3_VERSION[i]) return true
    if (actual[i] < MINIMUM_LIBFUSE3_VERSION[i]) return false
  }
  return true
}

module.exports = {
  discover
}
