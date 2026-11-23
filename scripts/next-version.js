'use strict'
// Picks the version number for the next release, so nobody has to bump it by hand:
//   - major.minor come from package.json (edit those yourself for a big release)
//   - patch counts up from the newest published release
//
//   package.json 0.2.0, no releases yet        -> 0.2.0
//   package.json 0.2.0, releases v0.2.0 v0.2.1 -> 0.2.2
//   package.json 0.3.0, newest release v0.2.7  -> 0.3.0
//
// Usage: node scripts/next-version.js [owner/repo]
// With a repo it reads that repo's GitHub releases (needs the gh CLI and GH_TOKEN, as in CI).
// Without one it reads local git tags.
const { execFileSync } = require('child_process')

function parse (v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())
  return m ? [+m[1], +m[2], +m[3]] : null
}

function cmp (a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function nextVersion (pkgVersion, tags) {
  const base = parse(pkgVersion)
  if (!base) throw new Error('package.json version must look like 1.2.3, got ' + pkgVersion)
  let next = base
  for (const t of tags) {
    const v = parse(t)
    if (!v) continue
    const bumped = [v[0], v[1], v[2] + 1]
    if (cmp(bumped, next) > 0) next = bumped
  }
  return next.join('.')
}

function releaseTags (repo) {
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (repo) return run('gh', ['release', 'list', '--repo', repo, '--limit', '1000', '--json', 'tagName', '--jq', '.[].tagName']).split(/\r?\n/)
  return run('git', ['tag', '--list', 'v*']).split(/\r?\n/)
}

if (require.main === module) {
  const pkg = require('../package.json')
  process.stdout.write(nextVersion(pkg.version, releaseTags(process.argv[2])) + '\n')
}

module.exports = { nextVersion }
