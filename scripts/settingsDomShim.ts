/**
 * scripts/settingsDomShim.ts — adj922 冒烟夹具用的 `obsidian` 替身（**浏览器内**，DOM 是真的）
 *
 * 与 `scripts/obsidianStub.ts` 的分工：
 *  · `obsidianStub.ts`：**Node 里**跑冒烟用（只满足 import 解析，没有 DOM）；
 *  · 本文件：**无头浏览器**里跑设置页夹具用 —— 这里的 `Setting` / `PluginSettingTab` 真的建 element，
 *    于是"哪个页签的容器里建了几个 item"可以直接量 DOM（见 `settingsDomProbe.ts`）。
 *
 * 用途只有一个：让 `src/settings.ts`（连同它的 DOM 构建）能被原样打包进浏览器夹具，
 * 由冒烟的 adj922 一节驱动 —— 证明「说明」页签不再混进「嵌入版」的内容。
 * 它**不参与插件产物**（`src/` 不 import 它）。
 */

type Opts = { cls?: string; text?: string; attr?: Record<string, string>; href?: string }

function apply(el: HTMLElement, o?: Opts): void {
  if (!o) return
  if (o.cls) el.className = o.cls
  if (o.text) el.textContent = o.text
  if (o.attr) for (const k of Object.keys(o.attr)) el.setAttribute(k, o.attr[k])
  if (o.href) el.setAttribute('href', o.href)
}

/** Obsidian 给 element 打的那批扩展方法（settings.ts 用到哪些就补哪些） */
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
proto.toggleClass = function (this: Element, c: string, on?: boolean) {
  this.classList.toggle(c, on === true)
  return this
}
proto.setCssStyles = function (this: Element) {
  return this
}
proto.setCssProps = function (this: Element) {
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
  setValue() { return this }
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
  addToggle(cb: (c: ToggleComponent) => unknown) { cb(new ToggleComponent(this.controlEl)); return this }
  addButton(cb: (c: ButtonComponent) => unknown) { cb(new ButtonComponent(this.controlEl)); return this }
}

export class Notice { constructor(..._a: unknown[]) {} }
export class PluginSettingTab {
  app: unknown
  plugin: unknown
  containerEl: HTMLElement
  constructor(app: unknown, plugin: unknown) {
    this.app = app
    this.plugin = plugin
    this.containerEl = document.createElement('div')
  }
  display(): void {}
  hide(): void {}
  /** 真宿主里 `update()` = 重新构建声明式设置；夹具里等价于重画（`settings.ts` 会调它） */
  update(): void { (this as unknown as { display: () => void }).display() }
}
export class Modal { constructor(..._a: unknown[]) {} }
export class Menu {}
export class Events { trigger(..._a: unknown[]): void {} }
export class Component {}
export class MarkdownRenderChild {}
export class TextFileView {}
export class TFile {}
export class TFolder {}
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
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const t = document.createElement('template')
  t.innerHTML = html
  return t.content
}
export class FileSystemAdapter {}
export const Platform = { isDesktopApp: true, isMobileApp: false }
/** 夹具里不该发生真实网络请求：真被调到就报错（免得"看起来通过"） */
export async function requestUrl(): Promise<never> { throw new Error('fixture: requestUrl 不该被调用') }
