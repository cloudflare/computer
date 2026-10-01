const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const manifest = readJson('package.json')
const lockPath = path.join(root, 'package-lock.json')
const changelogPath = path.join(root, 'CHANGELOG.md')
const verifyArtifacts = process.argv.includes('--artifacts')
const releaseTag = process.env.GITHUB_REF_TYPE === 'tag'
  ? process.env.GITHUB_REF_NAME
  : process.env.RELEASE_TAG

if (manifest.name !== 'fuse-napi') fail(`Unexpected package name ${JSON.stringify(manifest.name)}`)
if (!isValidVersion(manifest.version)) fail(`Invalid package version ${JSON.stringify(manifest.version)}`)

if (fs.existsSync(lockPath)) {
  const lock = readJson('package-lock.json')
  if (lock.version !== manifest.version || !lock.packages || !lock.packages[''] ||
      lock.packages[''].version !== manifest.version) {
    fail('package.json and package-lock.json versions must match exactly')
  }
}

if (releaseTag && releaseTag !== `v${manifest.version}`) {
  fail(`Release tag ${JSON.stringify(releaseTag)} must equal "v${manifest.version}"`)
}

if (process.env.npm_lifecycle_event === 'prepublishOnly' && !releaseTag) {
  fail('Publishing is only allowed from a verified release tag')
}

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
if (/not yet published to npm/i.test(readme)) {
  fail('README still claims that the package is not published')
}

let changelog
try {
  changelog = fs.readFileSync(changelogPath, 'utf8')
} catch (err) {
  fail(`Cannot read CHANGELOG.md: ${err.message}`)
}
if (!changelog.includes(`## ${manifest.version} - `)) {
  fail(`CHANGELOG.md must contain a dated section for ${manifest.version}`)
}
if (releaseTag || verifyArtifacts || process.env.npm_lifecycle_event === 'prepublishOnly') {
  const unreleased = changelogSection(changelog, 'Unreleased')
  if (/(?:^|\n)###\s|(?:^|\n)-\s/.test(unreleased)) {
    fail('CHANGELOG.md contains staged Unreleased entries; move them into the release section')
  }
}

if (verifyArtifacts) {
  const abiFiles = [
    'fuse-napi.abi127.node',
    'fuse-napi.abi137.node',
    'fuse-napi.abi147.node'
  ]
  const targets = [
    { directory: 'linux-x64', files: abiFiles },
    { directory: 'linux-arm64', files: abiFiles },
    { directory: 'darwin-x64', files: abiFiles },
    { directory: 'darwin-arm64', files: abiFiles },
    {
      directory: 'linux-x64-fuse4',
      files: abiFiles.concat(abiFiles.map(name => name.replace(/\.node$/, '.musl.node')))
    },
    {
      directory: 'linux-arm64-fuse4',
      files: abiFiles.concat(abiFiles.map(name => name.replace(/\.node$/, '.musl.node')))
    }
  ]
  for (const target of targets) {
    for (const abiFile of target.files) {
      const prebuild = path.join(root, 'prebuilds', target.directory, abiFile)
      let stat
      try {
        stat = fs.statSync(prebuild)
      } catch {
        fail(`Missing release prebuild: ${path.relative(root, prebuild)}`)
      }
      if (!stat.isFile() || stat.size === 0) {
        fail(`Release prebuild is empty or not a file: ${path.relative(root, prebuild)}`)
      }
    }
  }
}

function readJson (filename) {
  const absolute = path.join(root, filename)
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'))
  } catch (err) {
    fail(`Cannot read ${filename}: ${err.message}`)
  }
}

function isValidVersion (version) {
  if (typeof version !== 'string') return false
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match || !match[4]) return !!match
  return match[4].split('.').every(identifier => !/^\d+$/.test(identifier) || !/^0\d+/.test(identifier))
}

function changelogSection (source, heading) {
  const startMarker = `## ${heading}`
  const start = source.indexOf(startMarker)
  if (start === -1) fail(`CHANGELOG.md is missing the "${heading}" section`)
  const contentStart = source.indexOf('\n', start + startMarker.length)
  if (contentStart === -1) return ''
  const next = source.indexOf('\n## ', contentStart + 1)
  return source.slice(contentStart + 1, next === -1 ? source.length : next)
}

function fail (message) {
  console.error(`Release verification failed: ${message}`)
  process.exit(1)
}
