/**
 * bankFile.ts — 音色库（SF2/SF3）**落到插件目录**的存储层（adj729）
 *
 * ## 用户口径
 *
 * 「音色库下载或导入后，建议放在插件目录中，以便能随文库一起走」——
 * 此前音源只存在 **IndexedDB** 里（插件预览在 Obsidian 的 origin、嵌入版应用在
 * `http://127.0.0.1:<port>` 的 origin），换台机器 / 换库 / 清站点数据就没了，
 * 而且**不同步**：文库同步走了，音源不会跟着走。
 *
 * 现在：音源以文件形式放在**插件自己的目录**里 ——
 * `<配置目录>/plugins/<插件 id>/soundfonts/<库 id>.sf2`，
 * 于是"随文库一起同步"是最自然的结果（与 `data.json`、`main.js` 同级）。
 *
 * ## 为什么用 `vault.adapter` 而不是 `vault.createBinary`
 *
 * `.obsidian/` 是**配置目录**，Obsidian 的文件管理器不索引它 ⇒ 必须走底层适配器
 * （`adapter.readBinary/writeBinary/exists/mkdir`），`vault.*` 那套 API 看不见这些路径。
 *
 * ## 顺序（调用方按此顺序取音源）
 *
 * 插件目录文件 → IndexedDB（老用户的存量缓存）→ 内置资源（桌面随包）→ 联网下载；
 * **下载或导入成功后写进插件目录**（同时留一份在 IndexedDB，作为降级读取路径）。
 */
import { Notice, type App } from 'obsidian'

/** 音源文件在插件目录里的子目录名 */
const SOUNDFONT_DIR = 'soundfonts'

/** 音源文件存储（插件目录）——`soundbank.ts` 只依赖这个接口，不依赖 Obsidian */
export interface BankFileStore {
  /** 文件是否已在插件目录里 */
  exists(id: string): Promise<boolean>
  /** 读回字节（不存在/读失败 → null，不抛） */
  read(id: string): Promise<ArrayBuffer | null>
  /** 写入插件目录（自动建子目录） */
  write(id: string, data: ArrayBuffer): Promise<void>
  /** 插件目录里的相对路径（诊断/日志用） */
  pathOf(id: string): string
  /**
   * **让用户挑一个本地 `.sf2/.sf3` 并写进插件目录**（嵌入版"导入音色文件"走这里）。
   *
   * 为什么由插件来挑文件、而不是应用挑完再把字节发过来：SF2 有 32 MB，
   * 走 `postMessage` 要 base64（≈43 MB 字符串）——慢且吃内存；插件在 Obsidian 主窗口里
   * 自己弹一次文件选择器、直接写盘，一个字节都不用跨窗口搬。
   *
   * @returns 成功时给出写好的库 id；用户取消时 `{ canceled: true }`
   */
  importFromPicker(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
}

/** 用 Obsidian 的 `vault.adapter` 实现（`manifestDir` = 插件目录，如 `.obsidian/plugins/ijipu`） */
export function createBankFileStore(app: App, manifestDir: string): BankFileStore {
  const dir = `${manifestDir}/${SOUNDFONT_DIR}`
  const pathOf = (id: string): string => `${dir}/${id}.sf2`

  const ensureDir = async (): Promise<void> => {
    const adapter = app.vault.adapter
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir)
  }

  return {
    pathOf,
    async exists(id) {
      try {
        return await app.vault.adapter.exists(pathOf(id))
      } catch {
        return false
      }
    },
    async read(id) {
      try {
        const p = pathOf(id)
        if (!(await app.vault.adapter.exists(p))) return null
        return await app.vault.adapter.readBinary(p)
      } catch {
        return null
      }
    },
    async write(id, data) {
      await ensureDir()
      await app.vault.adapter.writeBinary(pathOf(id), data)
    },
    importFromPicker(id) {
      return new Promise((resolve) => {
        const input = createEl('input', { cls: 'ijipu-file-input-hidden', attr: { type: 'file', accept: '.sf2,.sf3' } })
        // 挂到文档里再点：某些宿主对游离 input 的 click() 不弹选择器
        document.body.appendChild(input)
        let settled = false
        const finish = (r: { ok: boolean; canceled?: boolean; error?: string }): void => {
          if (settled) return
          settled = true
          input.remove()
          resolve(r)
        }
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          if (!file) {
            finish({ ok: false, canceled: true })
            return
          }
          void file
            .arrayBuffer()
            .then(async (ab) => {
              try {
                await ensureDir()
                await app.vault.adapter.writeBinary(pathOf(id), ab)
                new Notice(`已导入音色数据 → ${file.name}（已保存到插件目录，随文库一起走）`, 5000)
                finish({ ok: true })
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                new Notice(`保存到插件目录失败：${msg}`, 8000)
                finish({ ok: false, error: msg })
              }
            })
            .catch((e: unknown) => {
              const msg = e instanceof Error ? e.message : String(e)
              new Notice(`读取音色文件失败：${msg}`, 8000)
              finish({ ok: false, error: msg })
            })
        })
        // 用户直接关掉选择器时不会触发 change ⇒ 给个"取消"兜底（窗口重新获得焦点后一小段时间）
        input.addEventListener('cancel', () => finish({ ok: false, canceled: true }))
        input.click()
      })
    },
  }
}
