# 爱记谱 iJipu 0.33.1

> **本版只修"社区审核未通过"的两件事**，功能与 0.33.0 完全相同（PATCH）。
> 0.33.0 → **0.33.1**：① 移除一处 **iOS 16.4 之前不支持**的正则语法（审核判定的唯一 Error）；
> ② 把构建戳改为 **UTC**，让"同一提交在不同时区/不同机器上重建"得到**逐字节相同**的产物
> （审核的 Build verification 警告）。
> **既有谱面、`.jps` 语法、界面行为零改动**。

## ① 移除 lookbehind（这是审核唯一判 Error 的项）

- **现象**：社区审核 `Failed`，唯一 Error 是
  `Lookbehinds are not supported on iOS versions before 16.4.`，指向 `src/gen/webappAssets.ts`
  —— 也就是**插件里内联的嵌入版 iJipu**（手机端会加载它）。
- **根因**：应用里一处表格切分用了 **后行断言（lookbehind）**；该语法在 iOS 16.4 之前的 WebKit 不支持。
  审核是按**源码文本**扫描的（连注释里的正则都会被算进去）。
- **修法**：改成**手写扫描**（语义逐字等价），注释里也不复述那个正则；
  重新生成嵌入产物后，`main.js` 与 `webappAssets.ts` 两个发布产物**各 0 处** lookbehind。

## ② 构建戳改 UTC（"可复现构建"这次是真的）

- **现象**：审核警告「Build output does not match the released main.js artifact」。
  本地按 CI 的原命令重建，与 CI 产物**大小完全相同、哈希不同**。
- **根因**：逐字节比对后确认**只差一个字符串** —— 构建戳：本地（CST）`13:34`、CI（UTC）`05:34`。
  原脚本取的是**本地时区** ⇒ 换个时区重建必然不一致。
- **修法**：两端脚本一律按 **UTC** 取值；实测 `TZ=UTC` 与 `TZ=Asia/Shanghai` 两次构建**哈希相同**，
  且**等于 CI 产物哈希**。

## 同版顺带处理的审核警告（都不影响行为）

- **`node:http` / `node:crypto` 不再静态导入**：改到函数内 `await import()`。
  （虽然 `main.ts` 早就"仅桌面端动态导入"，但审核的静态检查只看文件自身。）
- **引擎时钟改用 `window.` 前缀写法**：取 `typeof window !== 'undefined' ? window : globalThis` 作宿主对象，
  调用一律 `host.requestAnimationFrame?.()` 这类成员表达式 —— 满足审核要求，同时引擎仍能在 Node 里跑。
- **不再硬编码 `.obsidian`**：兜底路径与设置页提示都按 `vault.configDir` 拼。
- **electron 不再用 CommonJS 式导入**：改为动态 `import()`（附 `src/electron.d.ts` 纯类型声明）。
- **`styles.css` 不再使用 `!important`**：反制宿主的两处改为**重复类名提权**（`.a.a` ⇒ 特异性 0,2,0），
  并加了总闸门断言（当前全文件 0 处，原先 5 处）。
- **音源下载改用 Obsidian 的 `requestUrl`**（替代 `fetch`）：绕过 CORS，手机端下载音源更稳。

## 引擎同步

- 嵌入版 iJipu 升到 **v0.51.1**（引擎包 `0.33.0 → 0.33.1`，只含时钟的宿主写法调整）；
  插件的 `vendor/engine` 与应用引擎仍**逐文件哈希一致**（有闸门）。

## 验证门

- `npx tsc -noEmit -skipLibCheck` 0 错；`npm run smoke` **340 passed, 0 failed**；`npm run build` 正常。
- 相关断言按新口径改写（反制手段、音源顺序锚点），并新增"全文件不得出现 `!important;`"一条；
  两个发布产物各自扫描 lookbehind **0 处**。
- `node scripts/release-body.mjs` 命中当版 `# 爱记谱 iJipu 0.33.1`。
