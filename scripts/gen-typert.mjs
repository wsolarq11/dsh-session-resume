#!/usr/bin/env node
// Regenerate typert contract artifacts (lib/typert.host.*, lib/typert.remote-client.*)
// for this standalone package.
//
// WHY a shadow workspace root: @deepseek-ai/dsh-typert-generator only discovers
// packages that sit under <root>/packages/* referenced from a workspace
// tsconfig.host.json (see its loadRegistrations). A single repo root is never
// discovered, so we build a minimal shadow workspace, generate there, and copy
// the artifacts back into this repo's lib/.
//
// Usage:
//   node scripts/gen-typert.mjs <shadowRoot>
// where <shadowRoot> already contains:
//   tsconfig.host.json ......... composite; references:[{path:"./packages/session-resume"}]
//   tsconfig.client.json ....... composite; references:[{path:"./packages/session-resume"}]
//   packages/session-resume/package.json, src/, tsconfig.json, node_modules (link)
// This mirrors the DSH workspace pipeline; kept as the reproducible path to
// regenerate a lost lib/typert.* without a DSH checkout.
import { WorkspaceAnalyzer, FaceModelEmitter } from '@deepseek-ai/dsh-typert-generator'
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = '@dsh-external/dsh-session-resume'
const shadow = resolve(process.argv[2] ?? '')
if (!shadow || process.argv.length < 3) {
  console.error('usage: node scripts/gen-typert.mjs <shadowRoot>')
  process.exit(2)
}
const pkgDir = join(shadow, 'packages', 'session-resume')
if (!existsSync(join(pkgDir, 'package.json'))) {
  console.error('shadowRoot missing packages/session-resume; see script header')
  process.exit(2)
}

// chicken-and-egg: src/index.ts imports @dsh-external/.../typert which points at
// the lib/typert.* we are about to write; the host face model does not need that
// declaration, so checkDiagnostics is off for the self-referential import.
const model = new WorkspaceAnalyzer({ root: shadow, faces: ['host'], checkDiagnostics: false, mode: 'check' }).analyze()
const face = model.faces?.find((f) => f.face === 'host')
if (!face) { throw new Error('no host face produced by generator') }

const artifact = new FaceModelEmitter(face).emit(PKG)
const outDir = join(pkgDir, 'lib')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, `typert.${artifact.face}.js`), artifact.js)
writeFileSync(join(outDir, `typert.${artifact.face}.d.ts`), artifact.dts)
if (artifact.remote) {
  writeFileSync(join(outDir, 'typert.remote-client.js'), artifact.remote.js)
  writeFileSync(join(outDir, 'typert.remote-client.d.ts'), artifact.remote.dts)
  if (artifact.remote.dtsMap) writeFileSync(join(outDir, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
}
// copy back into this repo's lib/
const hereLib = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
mkdirSync(hereLib, { recursive: true })
for (const f of ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts']) {
  copyFileSync(join(outDir, f), join(hereLib, f))
}
if (artifact.remote?.dtsMap) copyFileSync(join(outDir, 'typert.remote-client.d.ts.map'), join(hereLib, 'typert.remote-client.d.ts.map'))
console.log('regenerated typert artifacts into', hereLib)