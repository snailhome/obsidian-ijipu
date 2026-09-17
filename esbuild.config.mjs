import esbuild from 'esbuild'
import process from 'process'
import builtins from 'builtin-modules'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
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
  plugins: [
    {
      name: 'png-dataurl',
      setup(build) {
        // adj458：图标 PNG（vendor/icons/）内联成 base64 data URI 编进 bundle —— 与上面的 worklet
        // 同一个理由：插件发布物只有 main.js / manifest.json / styles.css 三个文件，
        // **不能再带一个图标目录**，所以图标必须自包含（详见 src/assets.d.ts）。
        // 这里显式拼 mime，而不用 esbuild 的 dataurl loader —— 免得它按扩展名猜出来的 mime 不是 image/png。
        build.onLoad({ filter: /\.png$/ }, async (args) => ({
          contents: `export default "data:image/png;base64,${(await readFile(args.path)).toString('base64')}"`,
          loader: 'js',
        }))
      },
    },
    {
      name: 'worklet-raw',
      setup(build) {
        // 把 spessasynth_processor.min.js 以文本内联进 bundle —— main.js 单文件自包含，
        // 无需插件目录再放单独的 worklet 文件（解决「未找到内置 worklet」）。
        build.onLoad({ filter: /spessasynth_processor\.min\.js$/ }, async (args) => ({
          contents: await readFile(args.path, 'utf8'),
          loader: 'text',
        }))
      },
    },
  ],
})

if (prod) {
  await context.rebuild()
  process.exit(0)
} else {
  await context.watch()
}
