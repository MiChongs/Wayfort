// Copies the pre-built guacamole-common-js UMD-ish single file out of
// node_modules/ into public/vendor/ so we can serve it as a static asset
// (and load it via a Next.js Script tag), bypassing Turbopack/Webpack
// tree-shaking that splits the library across multiple chunks — which
// breaks the runtime because every internal module references the same
// `Guacamole` global.
//
// This script is invoked automatically by `npm install` via the
// `postinstall` script in package.json, and also defensively from `prebuild`.

import { copyFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"

const src = resolve(
  "node_modules/guacamole-common-js/dist/cjs/guacamole-common.min.js",
)
const dst = resolve("public/vendor/guacamole-common.min.js")

if (!existsSync(src)) {
  console.warn(
    `[copy-guacamole] source missing: ${src} — skipping (guacamole-common-js not installed?)`,
  )
  process.exit(0)
}

mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`[copy-guacamole] copied → ${dst}`)
