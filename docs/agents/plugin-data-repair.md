# 升级 / 重建 runtime 之后必须检查的数据

`pm install` 换 APK 或 `RootfsInstaller` 重解 runtime 之后，**用户数据里有两类东西会静默失效**。
两类都不是"装坏了"，而是「文件被替换/清掉了，引用还在」。出现症状时先按这里排查。

---

## 1. `docs/*.md` 丢了 ⇒ 插件详情页「插件声明的详细介绍文件无效」

**根因**：`tools/runtime/build-runtime.sh` 有两条删除规则，**必须同时豁免 `docs/`**：

```bash
find "$ROOTFS/opt/dsh/node_modules" -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) \
  ! -name 'README.md' ! -name 'readme.md' ! -path '*/docs/*' -delete    # ① 补 ! -path

find "$ROOTFS/opt/dsh/node_modules" -type d \( \
  -name test -o -name tests -o -name __tests__ -o -name example -o -name examples \
  \) -delete                                                          # ② docs 已从这里移除
```

只改 ② 的后果（2026-11-24 实测 `debug.32`）：

```text
16 个包有 docs/ 目录
detail_md=0          ← DETAIL.md / DETAIL.zh.md 全被 ① 删了，只剩 preview.svg
```

**快速判定**（设备侧）：

```bash
run-as com.dsh.android sh -c '
  R=files/runtime/rootfs/opt/dsh/node_modules/@deepseek-ai
  c=0; for d in $R/*/docs; do [ -f "$d/DETAIL.md" ] && c=$((c+1)); done; echo detail_md=$c'
```

**应急补**（不用等重新构建）：

```bash
python3 tools/plugin-docs.py pkgs.txt docsout 0.2.2-rc.5          # 拉真实 docs
cp -r docsout /sdcard/docsfix
# 设备侧（run-as 里一律用绝对路径）
cp -r /sdcard/docsfix /data/local/tmp/docsfix && chmod -R 755 /data/local/tmp/docsfix
run-as com.dsh.android sh -c '
  R=/data/user/0/com.dsh.android/files/runtime/rootfs/opt/dsh/node_modules/@deepseek-ai
  cd /data/local/tmp/docsfix
  for s in @deepseek-ai__*; do
    [ -d "$s/docs" ] || continue
    d="$R/${s#@deepseek-ai__}/docs"; [ -d "$d" ] || continue
    cp -f "$s/docs/"*.md "$d/" 2>/dev/null
  done'
```

⚠️ 注意哪些包**本来就没有** `docs/`（`plugin-docs.py` 会打 `no-docs`）：
`dsh-plugin-manager`、`dsh-plugin-market`、`dsh-client-ui-plugin-*`、`dsh-computer-use`、`dsh-cua` 等。
它们靠 `README.md` 回退，别指望补 `DETAIL.md` 能解决。

---

## 2. profile 里的第三方插件变成 `.l2s` 死链 ⇒ 插件页「未运行 / 包不可用」

**症状**（插件详情页红字）：

```text
dsh: cannot resolve profile bundle "dsh-app-pet" from the dsh installation or
/data/user/0/com.dsh.android/files/home/.dsh/profiles/web;
run 'dsh plugin --profile web install' if its dependency is not installed
```

**根因**：PRoot 的 link2symlink 把 profile 里 `node_modules/<pkg>` 的文件做成了
指向 rootfs 内 `/root/.l2s/.l2s.<hash>` 的**符号链接**。runtime 一重建，`.l2s` 内容没了，
而 `node_modules/<pkg>` 这些链接还挂着 ⇒ `require.resolve` 找不到入口。

**判定**（一看就懂）：

```bash
run-as com.dsh.android sh -c '
  D=files/home/.dsh/profiles/web/node_modules/dsh-app-pet
  ls -la $D | head
  echo ---; cat $D/package.json | head -5'
```

- 目录里全是 `lrwxrwxrwx … -> /data/data/com.dsh.android/files/runtime/rootfs/root/.l2s/…`
- `cat package.json` **输出为空**

⇒ 就是这个问题。

**修法：把真实文件装回去**（不用 `dsh plugin install`，也不需要 npm/pnpm）：

```bash
# 本机：从 npm 镜像拉 tarball 并解压（package/ 下就是包内容）
curl -fsSL https://registry.npmmirror.com/dsh-app-pet/-/dsh-app-pet-1.0.3.tgz -o pet.tgz
mkdir -p x && tar xzf pet.tgz -C x
cp -r x/package /sdcard/petfix/pet
```

```bash
# 设备：先 mv 走坏的目录（run-as 下 rm -rf 可能被拦），再拷真实文件
cp -r /sdcard/petfix /data/local/tmp/petfix && chmod -R 755 /data/local/tmp/petfix
run-as com.dsh.android sh -c '
  P=/data/user/0/com.dsh.android/files/home/.dsh/profiles/web/node_modules
  mv $P/dsh-app-pet $P/.dsh-app-pet.broken 2>/dev/null
  cp -r /data/local/tmp/petfix/pet $P/dsh-app-pet
  head -4 $P/dsh-app-pet/package.json'
```

重启 App 后**用 `engine.log` 验证**（比看 UI 可靠）：

```bash
run-as com.dsh.android sh -c 'grep -a "dsh-app-pet" files/logs/engine.log | tail -3'
```

正常会看到：

```text
dsh-app-pet: 桌宠配置指纹未变（d5848ace12b56727），跳过下发
dsh-app-pet: 已注册 deskpet 工具（包目录 …/node_modules/dsh-app-pet）
```

⇒ 说明 profile 已解析成功、插件在跑。UI 上的「未运行 / 包不可用」也会随之消失。

---

## 3. 通用排查顺序（遇到"XX 不好用了"先跑这三条）

```bash
# a) 文件在不在（docs / 入口）
run-as com.dsh.android sh -c 'ls files/runtime/rootfs/opt/dsh/node_modules/@deepseek-ai/<pkg>/docs'
run-as com.dsh.android sh -c 'ls files/home/.dsh/profiles/web/node_modules/<pkg>/lib'

# b) 是不是死链
run-as com.dsh.android sh -c 'ls -la files/home/.dsh/profiles/web/node_modules/<pkg> | head -4'

# c) 引擎到底认没认（最权威）
run-as com.dsh.android sh -c 'grep -a "<pkg>" files/logs/engine.log | tail -5'
```

`web.log` 放 WebView 的 `console.log`（前端探针都写这里），`engine.log` 放 Node 侧插件日志，
`app.log` 放宿主 Kotlin 日志（注意 `DshLog` 在子线程不落盘，需要 `runOnUiThread`）。
