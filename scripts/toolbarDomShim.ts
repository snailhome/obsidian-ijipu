/**
 * scripts/toolbarDomShim.ts — adj952 冒烟夹具用的 `obsidian` 替身（**浏览器内**，DOM 是真的）
 *
 * 与 `scripts/settingsDomShim.ts` 的分工：那个只够 `src/settings.ts` 建设置页；
 * 这个要够 `src/scorePane.ts`（连同它的依赖 `render` / `config` / `configDialog` / `defs` /
 * `icons` / `scoreMenu` / `openExternal` / `guides` / `cropBox`）**原样跑起来**。
 *
 * 用途只有一个：让**真的**谱面面板在无头浏览器里挂到一个仿「实时预览嵌入块」的 DOM 上，
 * 由 `scripts/toolbarDomProbe.ts` 驱动真实事件，量"点开工具条之后它会不会自己消失"
 * （= 用户报的「点一下闪一下」）。它**不参与插件产物**（`src/` 不 import 它）。
 *
 * ⚠ 这里只补"面板真正会用到的那几样"（元素扩展方法 + 几个类），别假装实现 Obsidian：
 *   夹具不追求覆盖全 API，追求"**面板的显隐逻辑**在真 DOM 里真的跑一遍"。
 */

type Opts = { cls?: string; text?: string; attr?: Record<string, string>; href?: string }

function apply(el: HTMLElement, o?: Opts): void {
  if (!o) return
  if (o.cls) el.className = o.cls
  if (o.text) el.textContent = o.text
  if (o.attr) for (const k of Object.keys(o.attr)) el.setAttribute(k, o.attr[k])
  if (o.href) el.setAttribute('href', o.href)
}

/** Obsidian 给 element 打的那批扩展方法（`scorePane.ts` 用到哪些就补哪些） */
const proto = Element.prototype as unknown as Record<string, unknown>
proto.empty = function (this: Element) {
  while (this.firstChild) this.removeChild(this.firstChild)
  return this
}
proto.createEl = function (this: Element, tag: string, o?: Opts) {
  const e = document.createElement(tag)
  apply(e, o)
  this.appendChild(e)
  return e
}
proto.createDiv = function (this: Element, o?: Opts) {
  return (this as unknown as { createEl: (t: string, o?: Opts) => HTMLElement }).createEl('div', o)
}
proto.createSpan = function (this: Element, o?: Opts) {
  return (this as unknown as { createEl: (t: string, o?: Opts) => HTMLElement }).createEl('span', o)
}
proto.setText = function (this: Element, t: string) {
  this.textContent = t
  return this
}
proto.setAttr = function (this: Element, k: string, v: string) {
  this.setAttribute(k, v)
  return this
}
proto.addClass = function (this: Element, ...c: string[]) {
  this.classList.add(...c)
  return this
}
proto.removeClass = function (this: Element, ...c: string[]) {
  this.classList.remove(...c)
  return this
}
proto.toggleClass = function (this: Element, c: string, on?: boolean) {
  this.classList.toggle(c, on === true)
  return this
}
proto.hasClass = function (this: Element, c: string) {
  return this.classList.contains(c)
}
/** adj799：真宿主里这是"写 CSS 自定义属性"；夹具里落到内联自定义属性上（量得到、不影响显隐） */
proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
  for (const k of Object.keys(props)) this.style.setProperty(k, props[k])
  return this
}
proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
  for (const k of Object.keys(styles)) this.style.setProperty(k, styles[k])
  return this
}

class Ctl {
  el: HTMLElement
  constructor(parent: HTMLElement, tag: string) {
    this.el = (parent as unknown as { createEl: (t: string, o?: Opts) => HTMLElement }).createEl(tag)
  }
}
class TextComponent extends Ctl {
  constructor(p: HTMLElement) { super(p, 'input') }
  setPlaceholder() { return this }
  setValue() { return this }
  onChange() { return this }
}
class DropdownComponent extends Ctl {
  constructor(p: HTMLElement) { super(p, 'select') }
  addOption() { return this }
  addOptions() { return this }
  setValue() { return this }
  onChange() { return this }
}
class SliderComponent extends Ctl {
  constructor(p: HTMLElement) { super(p, 'input') }
  setLimits() { return this }
  setValue() { return this }
  setDynamicTooltip() { return this }
  onChange() { return this }
}
class ToggleComponent extends Ctl {
  constructor(p: HTMLElement) { super(p, 'input') }
  setValue() { return this }
  onChange() { return this }
}
class ButtonComponent extends Ctl {
  constructor(p: HTMLElement) { super(p, 'button') }
  setButtonText(t: string) { this.el.textContent = t; return this }
  setCta() { return this }
  setTooltip() { return this }
  setIcon() { return this }
  onClick() { return this }
}

export class Setting {
  settingEl: HTMLElement
  nameEl: HTMLElement
  descEl: HTMLElement
  controlEl: HTMLElement
  constructor(containerEl: HTMLElement) {
    const c = containerEl as unknown as { createDiv: (o?: Opts) => HTMLElement }
    this.settingEl = c.createDiv({ cls: 'setting-item' })
    const info = (this.settingEl as unknown as { createDiv: (o?: Opts) => HTMLElement }).createDiv({ cls: 'setting-item-info' })
    this.nameEl = (info as unknown as { createDiv: (o?: Opts) => HTMLElement }).createDiv({ cls: 'setting-item-name' })
    this.descEl = (info as unknown as { createDiv: (o?: Opts) => HTMLElement }).createDiv({ cls: 'setting-item-description' })
    this.controlEl = (this.settingEl as unknown as { createDiv: (o?: Opts) => HTMLElement }).createDiv({ cls: 'setting-item-control' })
  }
  setName(n: string) { this.nameEl.textContent = n; return this }
  setDesc(d: string) { this.descEl.textContent = d; return this }
  setHeading() { this.settingEl.classList.add('setting-item-heading'); return this }
  setClass(c: string) { this.settingEl.classList.add(c); return this }
  setTooltip(t: string) { this.settingEl.setAttribute('title', t); return this }
  addText(cb: (c: TextComponent) => unknown) { cb(new TextComponent(this.controlEl)); return this }
  addDropdown(cb: (c: DropdownComponent) => unknown) { cb(new DropdownComponent(this.controlEl)); return this }
  addSlider(cb: (c: SliderComponent) => unknown) { cb(new SliderComponent(this.controlEl)); return this }
  addToggle(cb: (c: ToggleComponent) => unknown) { cb(new ToggleComponent(this.controlEl)); return this }
  addButton(cb: (c: ButtonComponent) => unknown) { cb(new ButtonComponent(this.controlEl)); return this }
}

export class Notice {
  constructor(..._a: unknown[]) {}
  setMessage() { return this }
  hide() { return this }
}
/** `Menu`：夹具里只记"被要求显示了哪些项"，不真的弹（`openScoreMenu` 会走到它） */
export class Menu {
  items: string[] = []
  addItem(cb: (i: { setTitle: (t: string) => unknown; setIcon: (t: string) => unknown; onClick: (f: () => void) => unknown; setChecked: (b: boolean) => unknown }) => unknown): this {
    const item = {
      setTitle: (t: string) => { this.items.push(t); return item },
      setIcon: () => item,
      onClick: () => item,
      setChecked: () => item,
      setDisabled: () => item,
      setIsLabel: () => item,
    }
    cb(item)
    return this
  }
  addSeparator(): this { return this }
  showAtMouseEvent(): this { return this }
  showAtPosition(): this { return this }
  hide(): this { return this }
}
export class Modal {
  containerEl: HTMLElement
  contentEl: HTMLElement
  constructor(_app?: unknown) {
    this.containerEl = document.createElement('div')
    this.contentEl = document.createElement('div')
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}
export class Component {}
export class MarkdownRenderChild {
  constructor(public containerEl?: HTMLElement) {}
}
export class TextFileView {}
export class ItemView {}
export class Plugin {}
export class PluginSettingTab {
  containerEl: HTMLElement
  constructor(_app?: unknown, _plugin?: unknown) { this.containerEl = document.createElement('div') }
  display(): void {}
}
export class Events {
  on(_n: string, _cb: (...a: unknown[]) => unknown): unknown { return {} }
  offref(_ref: unknown): void {}
  trigger(..._a: unknown[]): void {}
}
export class TFile {
  path = ''
  basename = ''
  name = ''
  extension = 'jps'
}
export class TFolder {}
export class WorkspaceLeaf {}
export class MarkdownView {}
export const Keymap = { isModEvent: () => false }
export const Platform = {
  isDesktopApp: true,
  isMobileApp: false,
  isDesktop: true,
  isMobile: false,
  isPhone: false,
  isTablet: false,
}
export class FileSystemAdapter {
  getBasePath(): string { return '' }
  getFullPath(p: string): string { return p }
}
export function normalizePath(p: string): string { return p.replace(/\\/g, '/') }
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const t = document.createElement('template')
  t.innerHTML = html
  return t.content
}
export function createDiv(o?: Opts): HTMLElement {
  const d = document.createElement('div')
  apply(d, o)
  return d
}
export function createEl(tag: string, o?: Opts): HTMLElement {
  const e = document.createElement(tag)
  apply(e, o)
  return e
}
export function createSpan(o?: Opts): HTMLElement {
  const e = document.createElement('span')
  apply(e, o)
  return e
}
export function createFragment(cb?: (f: DocumentFragment) => unknown): DocumentFragment {
  const f = document.createDocumentFragment()
  if (cb) cb(f)
  return f
}
/**
 * ⚠ 真宿主把 `createDiv` / `createEl` / `createSpan` / `createFragment` / `activeDocument` /
 * `activeWindow` **挂在全局**上（不是 import），而 `src/scorePane.ts` 正是当全局用的
 * （`const menuOnly = createDiv({ cls: 'ijipu-menu-only' })`）⇒ 夹具必须照样挂一遍，
 * 否则面板一挂载就 `ReferenceError: createDiv is not defined`。
 */
const g = globalThis as unknown as Record<string, unknown>
g.createDiv = createDiv
g.createEl = createEl
g.createSpan = createSpan
g.createFragment = createFragment
g.activeDocument = document
g.activeWindow = window
export function setIcon(parent: HTMLElement, _name: string): void {
  parent.createSpan?.({ cls: 'svg-icon' })
}
/**
 * 夹具里不该发生真实网络请求：真被调到就抛错（免得"看起来通过"）。
 * `bankFile` / `openExternal` 会静态 import 它 —— 只是函数体不执行。
 */
export async function requestUrl(): Promise<never> {
  throw new Error('fixture: requestUrl 不该被调用')
}
