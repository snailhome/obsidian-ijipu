/**
 * assets.d.ts — 构建期资源导入的类型声明
 *
 * `vendor/icons/*.png` 这些图标在构建时被**内联成 base64 data URI** 编进 `main.js`
 * （见 `esbuild.config.mjs` 的 `png-dataurl` 插件与 `vite.config.ts` 的 `assetsInlineLimit`）。
 *
 * 为什么必须内联（adj458）：插件发布物只有 `main.js` / `manifest.json` / `styles.css` 三个文件
 * （Obsidian 社区插件的发布约定，`copy2ob.bat` 也只拷这三个），**不能再带一个图标目录**。
 * 所以这里 `import icon from './x.png'` 拿到的**不是文件路径，而是一条自包含的 data URI**——
 * 图标随 bundle 走，离线/CI 都不依赖任何外部资源。
 */
declare module '*.png' {
  const dataUri: string
  export default dataUri
}
