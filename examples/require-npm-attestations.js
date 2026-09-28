'use strict';

/**
 * Customer preinstall check.
 * `npm audit signatures` (npm >= 9.5.0) verifies registry signatures and still
 * exits 0 when provenance attestations are missing. This reads one `npm view
 * <pkg>@<ver> --json` document and exits 1 when `.dist.attestations` is null.
 * Publish with `npm publish --provenance`. A publish without that flag must not ship.
 * Not wired into this repository's install.
 *
 *   npm view <pkg>@<ver> --json | node require-npm-attestations.js
 */

const fs = require('node:fs');

function attestationsOf(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const dist = doc.dist;
  if (!dist || typeof dist !== 'object') return null;
  return dist.attestations == null ? null : dist.attestations;
}

function main(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    process.stderr.write('npm view JSON did not parse\n');
    return 1;
  }
  if (attestationsOf(doc) == null) {
    process.stderr.write('dist.attestations is null; a publish without --provenance must not ship\n');
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(fs.readFileSync(0, 'utf8')));
}

module.exports = { main, attestationsOf };
