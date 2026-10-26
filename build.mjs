import { build } from 'esbuild'
import { existsSync } from 'node:fs'

if (!existsSync('dist')) {
  console.error('dist/ not found — run `vite build` first (or use `npm run build`).')
  process.exit(1)
}

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info'
})

console.log('✔ server bundled -> dist/server.cjs')
