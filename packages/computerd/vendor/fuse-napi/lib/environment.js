const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')

const { MACFUSE_URL } = require('./macfuse')

const EXEC_TIMEOUT = 5000
const MINIMUM_LIBFUSE_VERSION = Object.freeze([3, 10, 3])
const MINIMUM_MACFUSE_VERSION = Object.freeze([5, 3, 1])
const MACFUSE_INFO_PLIST = '/Library/Filesystems/macfuse.fs/Contents/Info.plist'

function checkEnvironment (options = {}, dependencies = {}) {
  const platform = dependencies.platform || os.platform()
  const access = dependencies.access || fs.promises.access.bind(fs.promises)
  const readFile = dependencies.readFile || fs.promises.readFile.bind(fs.promises)
  const exists = dependencies.exists || fs.existsSync
  const run = dependencies.run || runCommand
  const nativeRuntime = dependencies.nativeRuntime || null

  if (platform === 'linux') {
    validateNativeRuntime(platform, nativeRuntime)
    return checkLinux(options, { access, readFile, run }, nativeRuntime)
  }
  if (platform === 'darwin') {
    validateNativeRuntime(platform, nativeRuntime)
    return checkDarwin({ exists, run }, nativeRuntime)
  }

  return Promise.reject(environmentError(
    'EFUSEPLATFORM',
    `fuse-napi supports Linux and macOS; received unsupported platform ${platform}.`
  ))
}

async function checkLinux (options, dependencies, nativeRuntime) {
  let helper
  try {
    helper = await dependencies.run('fusermount3', ['--version'])
  } catch (cause) {
    throw environmentError(
      'EFUSEHELPER',
      'The FUSE 3 mount helper "fusermount3" is unavailable or not executable. ' +
      'Install the FUSE 3 runtime package (for Debian/Ubuntu: sudo apt-get install fuse3).',
      cause
    )
  }

  try {
    await dependencies.access('/dev/fuse', fs.constants.R_OK | fs.constants.W_OK)
  } catch (cause) {
    throw environmentError(
      'EFUSEDEVICE',
      'The FUSE device /dev/fuse is missing or is not readable and writable by this process. ' +
      'Load the fuse kernel module and grant the service account access to /dev/fuse.',
      cause
    )
  }

  if (options.allowOther || options.allowRoot) {
    let fuseConfig = ''
    try {
      fuseConfig = await dependencies.readFile('/etc/fuse.conf', 'utf8')
    } catch (cause) {
      throw environmentError(
        'EFUSEALLOWOTHER',
        'allowOther/allowRoot requires a readable /etc/fuse.conf containing user_allow_other.',
        cause
      )
    }
    if (!/^\s*user_allow_other(?:\s*(?:#.*)?)?$/m.test(fuseConfig)) {
      throw environmentError(
        'EFUSEALLOWOTHER',
        'allowOther/allowRoot requires "user_allow_other" in /etc/fuse.conf.'
      )
    }
  }

  return Object.freeze({
    ok: true,
    platform: 'linux',
    helper: 'fusermount3',
    helperVersion: firstLine(helper.stdout),
    device: '/dev/fuse',
    libfuseVersion: nativeRuntime && nativeRuntime.version,
    capabilities: runtimeCapabilities(nativeRuntime)
  })
}

async function checkDarwin (dependencies, nativeRuntime) {
  const roots = ['/Library/Filesystems/macfuse.fs']
  const libraries = [
    '/usr/local/lib/libfuse3.dylib',
    '/usr/local/lib/libfuse3.4.dylib'
  ]
  if (!roots.every(dependencies.exists) || !libraries.some(dependencies.exists)) {
    throw environmentError(
      'EMACFUSEDEPENDENCY',
      `macFUSE ${MINIMUM_MACFUSE_VERSION.join('.')} or newer with its libfuse3 ` +
      'compatibility runtime is not installed completely. ' +
      `Install and enable macFUSE from ${MACFUSE_URL}, then restart macOS if requested.`
    )
  }

  let macfuseVersion
  try {
    const result = await dependencies.run('/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      MACFUSE_INFO_PLIST
    ])
    macfuseVersion = firstLine(result.stdout)
  } catch (cause) {
    throw environmentError(
      'EMACFUSEVERSION',
      `Unable to verify the installed macFUSE version. fuse-napi requires macFUSE ` +
      `${MINIMUM_MACFUSE_VERSION.join('.')} or newer. Reinstall or upgrade macFUSE ` +
      `from ${MACFUSE_URL}.`,
      cause
    )
  }
  const parsedMacfuseVersion = parseVersion(macfuseVersion)
  if (!parsedMacfuseVersion ||
      compareVersions(parsedMacfuseVersion, MINIMUM_MACFUSE_VERSION) < 0) {
    throw environmentError(
      'EMACFUSEVERSION',
      `fuse-napi requires macFUSE ${MINIMUM_MACFUSE_VERSION.join('.')} or newer; ` +
      `the installed runtime reports ${JSON.stringify(macfuseVersion || 'an unknown version')}. ` +
      `Upgrade macFUSE from ${MACFUSE_URL}.`
    )
  }

  let version = null
  try {
    const result = await dependencies.run('pkg-config', ['--modversion', 'fuse3'])
    version = firstLine(result.stdout)
  } catch {
    // pkg-config is a build-time convenience; the verified runtime files are
    // sufficient for a prebuilt production installation.
  }

  return Object.freeze({
    ok: true,
    platform: 'darwin',
    runtime: '/Library/Filesystems/macfuse.fs',
    macfuseVersion,
    libfuseVersion: nativeRuntime && nativeRuntime.version
      ? nativeRuntime.version
      : version,
    capabilities: runtimeCapabilities(nativeRuntime)
  })
}

function runtimeCapabilities (runtime) {
  return Object.freeze({
    statx: !!(runtime && runtime.hasStatx)
  })
}

function validateNativeRuntime (platform, runtime) {
  if (!runtime) return

  const version = parseVersion(runtime.version)
  if (!version || compareVersions(version, MINIMUM_LIBFUSE_VERSION) < 0) {
    throw environmentError(
      'EFUSEVERSION',
      `fuse-napi requires libfuse ${MINIMUM_LIBFUSE_VERSION.join('.')} or newer; ` +
      `the loaded runtime reports ${JSON.stringify(runtime.version || 'an unknown version')}.`
    )
  }

  if (platform === 'darwin' && runtime.hasBufferRelease !== true) {
    throw environmentError(
      'EMACFUSEABI',
      'The loaded macFUSE compatibility runtime does not expose the buffer-release ' +
      `capability required by fuse-napi. Upgrade macFUSE from ${MACFUSE_URL}.`
    )
  }
}

function parseVersion (value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[.-]|$)/.exec(String(value || ''))
  if (!match) return null
  return match.slice(1).map(Number)
}

function compareVersions (left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function runCommand (command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      shell: false,
      timeout: EXEC_TIMEOUT,
      killSignal: 'SIGKILL'
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function environmentError (code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function firstLine (value) {
  return String(value || '').trim().split(/\r?\n/, 1)[0] || null
}

module.exports = {
  checkEnvironment,
  environmentError,
  MINIMUM_LIBFUSE_VERSION
}
