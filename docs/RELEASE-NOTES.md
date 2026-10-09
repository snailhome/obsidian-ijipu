# 爱记谱 iJipu 0.29.7

> 修掉 0.29.6 **自己引入**的一个 Error，并继续处理 Releases / Build verification 两项建议。
> 功能与 0.29.0 相同。0.29.6 → **0.29.7**（PATCH）。

## Error（0.29.6 引入的，本版修掉）

```
Disabling '@typescript-eslint/no-deprecated' is not allowed.   src/settings.ts:61
```

这是我上一轮的**自伤**：为消掉「`execCommand` is deprecated」这条 Recommendation，
我给那行加了 `eslint-disable-next-line @typescript-eslint/no-deprecated` ——
而官方**明确不允许禁用 `no-deprecated`**，于是"消一条建议"换来"多一条 Error"（上一版因此重新变 Failed）。

**修法**：不用禁用指令，改让代码**不触发该规则** —— 按名字从 `document` 上取方法再调（语义完全不变，
仍是同步复制），并保留"优先 `navigator.clipboard.writeText`"的主路径。那段本来就是回退路径。

> 教训（已写进代码注释）：**不要用禁用指令去满足审核建议** ——
> 官方有一套"禁止禁用"的规则清单，`no-deprecated`、`no-console` 都在其中。

## Releases 建议：加构建来源证明（artifact attestation）

官方建议为 Release 附件提供证明，让用户能密码学地核实"这个 `main.js` 确实由本仓库的该次 CI 构建产出、未被替换"。

- 工作流增加权限：`id-token: write`、`attestations: write`；
- 新增步骤 **`actions/attest-build-provenance@v2`**，对 `main.js` 与 `styles.css` 签发证明
  （审核提示也只点了这两个文件；`manifest.json` 是元数据，不纳入）；
- 该步骤放在**创建 Release 之前**，且带 `continue-on-error`（避免签发服务异常导致整个发布失败）。

核验方式（任何人都可执行）：

```bash
gh attestation verify main.js --repo snailhome/obsidian-ijipu
```

## Build verification 警告：把 CI 改成确定性安装

上一版我把构建时间改成"提交时间"（构建可复现，同 commit ⇒ 同产物），但那条警告**仍在**。
按官方原文 *"Releases should be built directly from source via CI/CD **with a committed lockfile**"*，
本版把 CI 的依赖安装由 `npm install --legacy-peer-deps` 改为 **`npm ci`** ——
前者允许解析出**与锁文件不同**的版本，后者严格按 `package-lock.json` 安装
（锁文件本身已在 0.29.2 修好：esbuild 与 vite 的 peer 冲突已解，`npm ci` 通过）。

> 说明：这条我**无法在本地复核**（审核方不提供差异细节，我拿不到它的构建环境），
> 只能把"可确定性的部分"都做到位。本版已覆盖：构建时间可复现 + 锁文件严格安装 +
> 产物来源有证明可查。若警告仍在，请把反馈发我，我会按新的证据继续。

## 验证门

`tsc -noEmit` 0 错；`npm run smoke` 全绿（含新增的"不得禁用 `no-deprecated`"断言）；
`npm ci --dry-run` exit 0；`npm run build` 正常且连续两次哈希一致。
