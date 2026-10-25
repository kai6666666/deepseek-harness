# 插件契约（Android host 插件）

> 这份清单来自**真机踩坑**，不是文档推演。五条全部属于同一类故障：
> **不崩、不红、日志只掉一行 WARN，功能静默消失。**
>
> 自动检查：`node tools/selftest-plugin-contract.mjs`（14 项，已挂 `build-apk` 第 9 步）。
> 也就是说：违反下面任意一条，**CI 出不了包**。

适用对象：`plugin-src/*` 里要随 APK 分发、由 `EngineManager` 解到 `$DSH_HOME` 下并挂 `*.patch.yml` 的 host 插件
（`dsh-android-shell` / `bubble` / `statusbar` / `uiagent` / `logs` / `toolchain` …）。

---

## 契约 ①　`provision.json` 必须真的进 zip

**现象**

```text
[engine] [dsh-android-toolchain] provision.json 读取失败，降级为空表: ENOENT …
```

然后插件照常“注册成功”，但**任何后端（alpine / termux / linux-glibc）都不存在**，
`groups` 也是空的 —— 工具在，点下去什么都不做。

**根因**：`index.js` 用 `readFileSync(join(HERE, "..", "provision.json"))` 读，而这个文件
从来只存在于工作区级 `plugin-src/`，没进 `DSHAPP-main/plugin-src/`，更没进 zip。

**正确做法**

```bash
# 打包必须显式列举，不要用 `zip -r 目录`（会把 node_modules、.DS_Store 一起带进去）
python3 - <<'PY'
import zipfile, os
root = "plugin-src/dsh-android-toolchain"
out  = "app/src/main/assets/dsh-android-toolchain.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for rel in ("package.json", "provision.json", "lib/index.js"):
        z.write(os.path.join(root, rel), rel)
PY
```

**自动检查**：`unzip -Z1` 列条目，`package.json` / `provision.json` / `lib/index.js` 必须全在。

---

## 契约 ②　`virtualPrefix` 从 `backends` 层读，不是 `groups` 层

**现象**：代码里写着“支持虚拟包组”，但那个分支永远走不到（值永远 `undefined`）。

**为什么**：`provision.json` 的层级是

```json
{
  "backends": {
    "alpine": { "install": [...], "virtualPrefix": "--virtual" }
  },
  "groups": {
    "node": { "label": "…", "alpine": { "pkgs": [...] } }   ← 这里没有 virtualPrefix
  }
}
```

`spec`（`PROVISION.groups[key][backendName]`）里**没有**这个字段。

**正确写法**

```js
// ✅ 读 backend（backendSpec(backendName) 的返回值）
const virtualGroup = backend.virtualPrefix ? `dsh-tc-${Date.now().toString(36)}` : null;
const pkgsArg = virtualGroup
  ? [backend.virtualPrefix, virtualGroup, ...pkgs].join(" ")
  : [...pkgs].join(" ");

// ❌ 别这么写：spec 里没有 virtualPrefix
// const virtualGroup = spec?.virtualPrefix ? … : null;
```

**收益**：`apk add --virtual <group> …` 装成一组，撤的时候 `apk del <group>` 一次收掉，
不会因为逐个删包把别的工具带崩。

**自动检查**：必须出现 `backend.virtualPrefix`，**且**不允许出现 `spec?.virtualPrefix`（反向断言）。

---

## 契约 ③　`export const inject` 必须含 `tools`

**现象**

```text
[engine] [dsh-android-toolchain] 工具注册失败，已跳过（HTTP 接口仍可用）:
  Error: cannot get property "tools" without inject
```

插件加载正常、HTTP 接口也能用，**但工具在列表里根本不出现**。

**为什么 `?.` 救不了**

```js
if (typeof ctx.tools?.register === "function") { … }
```

DSH 的 `ctx` 是 **Proxy**：访问未 inject 的属性时，异常发生在 **getter 内部**，
`?.` 短路发生在取到 `undefined` 之后 —— 根本轮不到它。

**正确写法**

```js
export const inject = ["webServer", "tools"];   // 用到哪个服务就写哪个
```

同理：用到 `shell` 就写 `"shell"`，用到 `fs` 就写 `"fs"`。**宁可 inject 多一点**：
多声明一个存在的服务没有代价，少声明一个就是静默失效。

**自动检查**：正则抓 `export const inject = [...]`，断言含 `"tools"`。

---

## 契约 ④　每个 `ctx.tools.register()` 都必须带 `output`

**现象**（会骗人：报错只点第一个）

```text
TypeError: tool "android_toolchain" must declare output { schema, render, presentationMeta? }
```

补完第一个，报错**换名字**：

```text
TypeError: tool "android_native_precheck" must declare output { … }
```

因为 `register` 是**逐个校验**的：漏一个，**整段注册一起失败，所有工具都不出现**。

**正确写法**

```js
ctx.tools.register({
  name: "android_toolchain",
  description: "…",
  parameters: { … },
  execute: async (args) => { … },
  output: {                                // ★ 必需
    schema: { type: "object", additionalProperties: true, properties: { … } },
    render: (_args, value) => [{ type: "text", text: renderToolchain(value) }],
  },
});
```

`schema` 建议宽松（`additionalProperties: true`、不写 `required`），因为同一个工具常常
按 `action` 返回不同形状；`render` 里再按形状分支渲染，比让 schema 精确到每个分支更实用。

**自动检查**：`register({` 的个数 ≤ `output: {` 的个数。

---

## 契约 ⑤　超时/取消要杀掉**整个进程组**（G-13）

**现象**：安装命令超时后，界面报失败，但 `ps` 里 proot 拉起的 node 还在，端口被占，
下一次启动撞 `EADDRINUSE`。

**为什么**：`child.kill()` 只杀直接子进程（proot 壳），孙进程（真正的 node）留下。

**正确写法**

```js
const child = spawn(argv[0], argv.slice(1), { …, detached: true });  // ★ 成为进程组 leader

function killTree(child) {
  if (!child || child.killed) return;
  try { process.kill(-child.pid, "SIGKILL"); }        // 负号 = 整个进程组
  catch (e) { if (e?.code !== "ESRCH") { try { child.kill("SIGKILL"); } catch {} } }
  try { child.kill("SIGKILL"); } catch {}
}

const timer = setTimeout(() => killTree(child), 600_000);   // ★ 不要裸 child.kill
```

**自动检查**：`detached: true` 恰好两处（runSync + install）、`killTree(child)` 调用两处，
且超时路径里没有裸 `child.kill("SIGKILL")`（只剩 `killTree` 内两处兜底）。

---

## 新插件上线 checklist

```text
[ ] package.json：name / version / type:"module" / main "./lib/index.js"
[ ] provision.json（若用到后端表）—— 且**真的在 zip 里**
[ ] export const inject = [...] 含所有用到的服务（尤其 tools）
[ ] 每个 register 都有 output { schema, render }
[ ] spawn 带 detached:true，超时走 killTree
[ ] zip 显式列举三个文件，不用 zip -r
[ ] EngineManager 四处：常量 / ensureXxx() / writeXxxPatch() / 启动调用 + patch 收集
[ ] node --check lib/index.js
[ ] node tools/selftest-plugin-contract.mjs  （14 项）
[ ] 装机后真机验证（见下）
```

## 真机验证的正确姿势

**不要**用 `logcat -d | grep ' DSH'` —— 在 Operit 这类宿主环境里，AI 自身的推理日志会把
main buffer 灌满，DSH 的几十行早被挤出去（实测：查出来是空的）。

```bash
PID=$(pidof com.dsh.android)
logcat -d --pid=$PID | grep -E '工具链|工具注册|TypeError|引擎就绪'
```

判定标准：

```text
✓ 已安装工具链插件 dsh-android-toolchain (20 741 字节)
✓ 已写入工具链 overlay: toolchain.patch.yml
✓ 引擎就绪: http://127.0.0.1:3080/?token=…
✗ 注册失败 / TypeError 出现次数应为 0
```

`/api/tools` 这类 HTTP 端点即使带着 token 也会 401（鉴权走的不是 query/header/cookie 三种常见形式），
**别把时间花在猜 API 上** —— 看 `--pid` 日志与 GUI 工具列表就够了。