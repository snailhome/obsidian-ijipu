/**
 * render/svgUtil.ts — SVG 输出用的两个**共用小工具**（adj965 抽出）
 *
 * ## 为什么抽出来
 *
 * `xmlEsc` 与 `r1n` 原本是 `render/index.ts` 里的**私有**函数；`adj965` 的水印/背景层
 * （`render/overlay.ts`）同样要用它们：
 *  · **文本转义**：水印文本直接来自 `# jps-config`（可能是别人给的 `.jps`）⇒ 里面一个 `<` 或 `&`
 *    就会打坏整份 SVG（甚至注入标签）——**绝不能各写一套、也绝不能漏**；
 *  · **数字格式**：SVG 里出现 `12.340000000000002` 这类串既难看又会撑大产物（导出位图/PDF 时逐字节不同）。
 *
 * 而"同一个格式化口径只允许一处定义"是项目铁律（见 AGENTS 六之二·4）⇒ 抽到这里，
 * `render/index.ts` 与 `render/overlay.ts` 都从这里导入。
 *
 * 本模块**零依赖、零 DOM**（引擎闸门 `adj770` 要求）。
 */

/** SVG 数字：保留 **1 位**小数（坐标/尺寸的通用口径） */
export const r1n = (v: number) => Math.round(v * 10) / 10

/**
 * SVG 数字：保留 **2 位**小数。
 * adj638：角标净距是**亚像素**量（13px 调号下 0.2px、16px 下 0.25px）⇒ 只留 1 位会被舍成同一个值。
 */
export const r2n = (v: number) => Math.round(v * 100) / 100

/** XML 文本转义（`&` 必须最先替换，否则会把后面生成的实体再转义一次） */
export function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
