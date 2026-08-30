import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import builtins from 'builtin-modules'

/**
 * obsidian-ijipu 构建（vite rolldown，沙箱可用）。
 * 产物 main.js（CJS，Obsidian 加载 require('obsidian') 由宿主提供），
 * @ijipu/engine 以源码被 bundle 进 main.js（与 ijipu 主项目共享单份引擎源码）。
 * 注意：DSH 沙箱禁止 esbuild 的 Go service spawn，故不用 esbuild CLI；vite(rolldown) 可正常构建。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ijipu\/engine$/, replacement: fileURLToPath(new URL('../ijipu/packages/ijipu-engine/src/engine/index.ts', import.meta.url)) },
    ],
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    outDir: '.',
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: ['obsidian', 'electron', ...builtins],
    },
  },
})
