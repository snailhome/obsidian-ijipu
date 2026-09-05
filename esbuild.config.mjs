import esbuild from 'esbuild'
import process from 'process'
import builtins from 'builtin-modules'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const prod = process.argv[2] === 'production'

// @ijipu/engine 以源码被 bundle 进 main.js（与 ijipu 主项目共享单份引擎源码）。
// engine 纯 TS 零运行时外部依赖（obsidian/electron 由宿主提供，标记 external）。
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/*',
    '@codemirror/lang-*',
    '@lezer/*',
    ...builtins,
  ],
  format: 'cjs',
  target: 'es2020',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  alias: {
    '@ijipu/engine': path.resolve(__dirname, './vendor/engine/index.ts'),
  },
})

if (prod) {
  await context.rebuild()
  process.exit(0)
} else {
  await context.watch()
}
