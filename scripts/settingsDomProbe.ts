/**
 * scripts/settingsDomProbe.ts — adj922 冒烟夹具：在**无头浏览器**里把设置页真的建一遍。
 *
 * 由冒烟的 adj922 一节这样用：生成一个几行的入口（`import { IJipuSettingTab } from '../src/settings'`
 * ＋ `import { runSettingsProbe } from '../scripts/settingsDomProbe'` ＋ 调用），用 esbuild 打成
 * 浏览器包、塞进一个空白 HTML（只有一个 `<pre id="out">`），再用 `--dump-dom` 取回量到的 JSON。
 *
 * 量什么：**按页签点按钮之后**，该页签那个 `.ijipu-settings-panel` 里
 *  · `.setting-item` 的条数（itemCount）与**逐条的 `.setting-item-name` 文本**（names，按 DOM 顺序）；
 *  · 面板的**直接子元素 class 序列**（panelChildren，用来钉"赞赏图必须是最后一个子元素"）；
 *  · `.ijipu-donate-qr` 的个数（qr，证明「说明」真的建出来了、夹具没空跑）。
 *
 * ⚠ 入口要**按页签点一下按钮**再量（`display()` 默认停在「嵌入版」）：用户报的正是**切到「说明」之后**
 *   才出现的多出来的一段，只有点过去才看得到。
 */

/** 只要求"能 new、能 display"——真类是 `src/settings.ts` 的 `IJipuSettingTab`（浏览器包里同一个类） */
type SettingTabCtor = new (app: unknown, plugin: unknown) => { containerEl: HTMLElement; display: () => void }

const TABS = ['嵌入版', '说明', '诊断']

/** 夹具的假宿主：只给设置页会读到的东西（真值形态照抄 `main.ts` 的字段名） */
function makeHost(): { app: unknown; plugin: unknown } {
  const plugin = {
    manifest: { id: 'ijipu', version: '0.38.0' },
    settings: {
      embedIjuipu: true,
      embedRoot: '',
      embedOpenMode: 'right',
      embedFollowTheme: true,
      exportRange: 'view',
      imageScale: 2,
    },
    allowExternalApi: false,
    saveSettings: async () => undefined,
    registerSettingsRefresh: () => undefined,
    syncEmbedRibbon: () => undefined,
    disposeEmbed: async () => undefined,
    soundfontPath: (id: string) => '.obsidian/plugins/ijipu/soundfonts/' + id + '.sf2',
    readSoundfont: async () => null,
    importSoundfont: async () => ({ ok: true }),
    buildDiagnosticsReport: () => '（夹具）诊断报告',
    lastCropInfo: null,
    lastToolbarInfo: null,
    lastToolbarClick: null,
    lastEmbedError: null,
  }
  const app = { vault: { configDir: '.obsidian' } }
  return { app, plugin }
}

export function runSettingsProbe(IJipuSettingTab: SettingTabCtor): void {
  const buildTab = (tab: string): HTMLElement => {
    const containerEl = document.createElement('div')
    containerEl.className = 'vertical-tab-content'
    const { app, plugin } = makeHost()
    const t = new IJipuSettingTab(app, plugin)
    t.containerEl = containerEl
    t.display()
    const btns = Array.from(containerEl.querySelectorAll('button.ijipu-settings-tab')) as HTMLElement[]
    const btn = btns.find((b) => (b.textContent ?? '') === tab)
    if (!btn) throw new Error('夹具：找不到页签按钮 ' + tab)
    btn.click()
    return containerEl
  }
  const measure = (tab: string): unknown => {
    const containerEl = buildTab(tab)
    const panel = containerEl.querySelector('.ijipu-settings-panel') as HTMLElement
    const items = Array.from(panel.querySelectorAll('.setting-item')) as HTMLElement[]
    return {
      tab,
      buttons: Array.from(containerEl.querySelectorAll('button.ijipu-settings-tab')).map((b) => b.textContent),
      panelChildren: Array.from(panel.children).map((c) => c.className),
      itemCount: items.length,
      names: items.map((it) => {
        const n = it.querySelector('.setting-item-name')
        return n ? (n.textContent ?? '') : ''
      }),
      qr: panel.querySelectorAll('.ijipu-donate-qr').length,
    }
  }
  const out = document.getElementById('out')
  if (out) out.textContent = JSON.stringify(TABS.map(measure))
}
