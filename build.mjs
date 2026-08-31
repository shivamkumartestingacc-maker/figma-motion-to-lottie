import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

const watch = process.argv.includes('--watch')

mkdirSync('dist', { recursive: true })

const common = {
  bundle: true,
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  target: ['es2020'],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
}

const mainOpts = {
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  platform: 'browser',
  format: 'iife',
}
const uiOpts = {
  ...common,
  entryPoints: ['src/ui.ts'],
  outfile: 'dist/ui.js',
  platform: 'browser',
  format: 'iife',
}

if (watch) {
  const [{ build: build1 }, { build: build2 }] = await Promise.all([
    import('esbuild'),
    Promise.resolve({}),
  ])
  const ctxs = await Promise.all([
    (await Promise.resolve(1), (await import('esbuild')).context(mainOpts)),
    (await import('esbuild')).context(uiOpts),
  ])
  for (const c of ctxs) {
    c.onEnd(() => copyFileSync('src/ui.html', 'dist/ui.html'))
  }
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('watching…')
} else {
  const [a, b] = await Promise.all([build(mainOpts), build(uiOpts)])
  void a
  void b
  copyFileSync('src/ui.html', 'dist/ui.html')
  console.log('build done')
}
