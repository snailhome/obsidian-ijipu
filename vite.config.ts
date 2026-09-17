import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import builtins from 'builtin-modules'

/**
 * obsidian-ijipu 构建（vite rolldown，沙箱可用）。
 * 产物 main.js（CJS，Obsidian 加载 require('obsidian') 由宿主提供），
 * @ijipu/engine 以源码被 bundle 进 main.js（vendor/engine 为插件仓库内置引擎源码，自包含、可上社区/CI）。
 * 注意：DSH 沙箱禁止 esbuild 的 Go service spawn，故不用 esbuild CLI；vite(rolldown) 可正常构建。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ijipu\/engine$/, replacement: fileURLToPath(new URL('./vendor/engine/index.ts', import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    // outDir 必须为项目根目录（Obsidian 插件结构要求 `main.js` 与 `manifest.json`
    // 同级：`<plugin>/main.js`）。emptyOutDir 保持 false，防御 Vite 在写入 `main.js`
    // 时清空源文件目录（Vite 8 已对 outDir=根目录加防御性警告）。
    outDir: '.',
    emptyOutDir: false,
    // adj458：图标 PNG（vendor/icons/*.png）必须**内联**成 data URI —— 发布物只有
    // main.js / manifest.json / styles.css 三个文件，不能再带一个图标目录（详见 src/assets.d.ts）。
    // 现有图标都 < 1KB，Vite 默认阈值 4KB 本已覆盖；这里显式抬高到 64KB 把意图钉死：
    // 将来万一换用更大的图标，也不会被悄悄拆成独立文件、发布后图标全空。
    assetsInlineLimit: 65536,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: ['obsidian', 'electron', ...builtins],
    },
  },
})
