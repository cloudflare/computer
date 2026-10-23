const FUSE3_OPTION_ERROR_PREFIX = 'Invalid FUSE 3 option configuration'

function validateFuse3Options (options, platform = process.platform) {
  if (options.nonEmpty === true) {
    throw optionError(
      'ERR_FUSE_OPTION_REMOVED',
      ['nonEmpty'],
      '"nonEmpty"/"nonempty" was removed in FUSE 3; remove the option. ' +
      'FUSE 3 permits non-empty mountpoints without it.'
    )
  }

  if (hasValue(options, 'fd')) {
    throw optionError(
      'ERR_FUSE_OPTION_INTERNAL',
      ['fd'],
      '"fd" is managed internally by libfuse3 and cannot be supplied by an application.'
    )
  }

  if (hasValue(options, 'userId')) {
    throw optionError(
      'ERR_FUSE_OPTION_INTERNAL',
      ['userId'],
      '"userId"/"user_id" is managed internally by fusermount3. ' +
      'Use "uid" only when libfuse should override returned file ownership.'
    )
  }

  rejectConflict(
    options,
    ['allowOther', 'allowRoot'],
    '"allowOther" and "allowRoot" are mutually exclusive in FUSE 3.'
  )
  rejectConflict(
    options,
    ['kernelCache', 'autoCache'],
    '"kernelCache" and "autoCache" select incompatible cache policies.'
  )

  if (options.directIo === true && (options.kernelCache === true || options.autoCache === true)) {
    const cacheOption = options.kernelCache === true ? 'kernelCache' : 'autoCache'
    throw optionError(
      'ERR_FUSE_OPTION_CONFLICT',
      ['directIo', cacheOption],
      `"directIo" cannot be combined with "${cacheOption}" because direct I/O bypasses the kernel page cache.`
    )
  }

  if (options.noforget === true && hasValue(options, 'remember')) {
    throw optionError(
      'ERR_FUSE_OPTION_CONFLICT',
      ['noforget', 'remember'],
      '"noforget" and "remember" are mutually exclusive inode-retention policies.'
    )
  }

  if (hasValue(options, 'acAttrTimeout') && options.autoCache !== true) {
    throw optionError(
      'ERR_FUSE_OPTION_DEPENDENCY',
      ['acAttrTimeout', 'autoCache'],
      '"acAttrTimeout" is only meaningful when "autoCache" is enabled.'
    )
  }

  if (platform !== 'linux' && (options.blkdev === true || hasValue(options, 'blksize'))) {
    const names = options.blkdev === true ? ['blkdev'] : ['blksize']
    throw optionError(
      'ERR_FUSE_OPTION_PLATFORM',
      names,
      `"${names[0]}" is supported only by Linux libfuse3.`
    )
  }

  if (hasValue(options, 'blksize') && options.blkdev !== true) {
    throw optionError(
      'ERR_FUSE_OPTION_DEPENDENCY',
      ['blksize', 'blkdev'],
      '"blksize" is only valid for a FUSE block-device mount with "blkdev: true".'
    )
  }

  if (options.blkdev === true && !hasValue(options, 'fsname')) {
    throw optionError(
      'ERR_FUSE_OPTION_DEPENDENCY',
      ['blkdev', 'fsname'],
      '"blkdev" requires an explicit "fsname" identifying the backing device.'
    )
  }

  if (platform !== 'darwin' && options.displayFolder === true) {
    throw optionError(
      'ERR_FUSE_OPTION_PLATFORM',
      ['displayFolder'],
      '"displayFolder" is a macFUSE-only presentation option.'
    )
  }

  if (hasValue(options, 'name') && options.displayFolder !== true) {
    throw optionError(
      'ERR_FUSE_OPTION_DEPENDENCY',
      ['name', 'displayFolder'],
      '"name" is only used as a macFUSE volume name when "displayFolder" is enabled.'
    )
  }

  if (hasValue(options, 'modules')) validateModuleList(options.modules)
}

function validateModuleList (value) {
  const modules = value.split(':')
  if (modules.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw optionError(
      'ERR_FUSE_OPTION_VALUE',
      ['modules'],
      '"modules" must be a colon-separated list of non-empty libfuse module identifiers.'
    )
  }
}

function rejectConflict (options, names, message) {
  if (names.every(name => options[name] === true)) {
    throw optionError('ERR_FUSE_OPTION_CONFLICT', names, message)
  }
}

function hasValue (options, name) {
  return options[name] !== undefined && options[name] !== null
}

function optionError (code, options, message) {
  const error = new TypeError(`${FUSE3_OPTION_ERROR_PREFIX}: ${message}`)
  error.code = code
  error.options = Object.freeze([...options])
  return error
}

module.exports = {
  validateFuse3Options
}
