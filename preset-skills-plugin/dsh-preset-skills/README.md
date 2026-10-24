# dsh-preset-skills

随 APK 分发的**中文 skill 包**：解决「AI 每次做 DSH 相关改造都要重新摸一遍项目结构」
这个低效问题。用户提出需求时，AI 直接加载对应的 skill 即可，不必再翻引擎源码。

## 为什么是 skill 而不是更长的一段提示词

提示词是**常驻**的 —— 每一轮请求都占上下文，而且塞得越满，模型对每一句的注意力越薄。
skill 是**按需**的：目录里只有 `name` + `description` 两行常驻（模型据此判断要不要用），
正文在 `skill` 工具被调用时才进上下文。

所以分工是：**创造模式的 persona 只写「什么时候该加载哪一份」，细节全在 skill 里。**

## 为什么直接落在 `$DSH_HOME/skills/`

`dsh-skill-filesystem` 的发现根里，`$DSH_HOME/skills`（`USER_DSH_RANK=400`）是**全局根**：
`includeDefaultRoots` 默认 true，而**没有一个预设行写 `dshHome`**，
于是它回落到 `$DSH_HOME`。结果是**每个预设都会扫到这个目录**。

因此本包**不需要改任何一份 `cordis.patch.yml`** —— 这也正是「用户有需求时直接注入」
这句话能成立的原因。

⚠️ 对比创造模式原有的 `skill-filesystem` 行：它写的是 `customSkillDirs`（rank 300），
指向 `@deepseek-ai/dsh-agent-preset/skills/`，那是**官方英文 skill**的落点。
两者不冲突，会一起出现在 catalog 里。

## 包内文件

```
skills/dsh-mobile-theme/SKILL.md     做界面主题 / 换肤 / 配色 / 深色适配
skills/dsh-desktop-pet/SKILL.md      悬浮球外观 / 桌面宠物 / 精灵图动画
```

两份都只解决一类问题，边界清楚（见各自的 frontmatter `description`）。

## 打包与分发

源文件在 `preset-skills-plugin/dsh-preset-skills/skills/`，**入库**。
打包产物 `app/src/main/assets/preset-skills.zip` **不入库**
（`.gitignore` 第 33 行 `app/src/main/assets/*` 已覆盖，与 `preset-razor.zip` 同一规矩）。

```powershell
cd preset-skills-plugin\dsh-preset-skills
Compress-Archive -Path skills\dsh-mobile-theme,skills\dsh-desktop-pet `
                 -DestinationPath ..\..\app\src\main\assets\preset-skills.zip -Force
```

⚠️ **zip 里不能有顶层目录**：条目必须是 `dsh-mobile-theme/SKILL.md`，
而不是 `skills/dsh-mobile-theme/SKILL.md`。多一层就会让一级目录名与
`EngineManager.PRESET_SKILL_NAMES` 对不上，`ensurePresetSkills()` 删不掉旧的。

⚠️ **改了 zip 里任何东西都必须 bump `EngineManager.PRESET_SKILLS_VERSION`**。
幂等判据是版本戳而不是「文件在不在」—— 只看文件存在会让老设备永远停在旧版内容。

新增一份 skill 时，`PRESET_SKILL_NAMES` 那个列表也要同步加名字，
否则旧版本不会被清掉（会与新解出来的并存，同名时行为未定义）。

## 装载流程（`EngineManager.ensurePresetSkills()`）

1. 版本戳一致 → 直接返回。
2. 只删 `PRESET_SKILL_NAMES` 里的那几个子目录（**不是整个 `skills/`** ——
   那是用户自己的目录，他手写的 skill 也放这儿）。
3. 解 `preset-skills.zip` 到 `$DSH_HOME/skills/`，写版本戳。

装不上不阻断启动（打 warning，只是少这两份 skill）。

## skill 的契约（写新 skill 时照这个）

```markdown
---
name: kebab-case-名字          # 必须 ^[a-z0-9]+(-[a-z0-9]+)*$，且与目录名一致
description: 一句话说清「什么时候用」   # 模型**只**凭这一行决定要不要加载
---

正文（Markdown）
```

⚠️ `name` 与 `description` 缺任何一个，引擎会**静默忽略**整个文件
（日志里只有一行 `skill file ... ignored`）。名字不合法同样被丢弃。

⚠️ `description` 是**唯一**的决定依据，所以要写「什么场景该用」而不是「这是什么」。
一份写得很好的 skill，若 description 写成「关于主题的一切」，模型就不知道该在
「做个绿色主题」时加载它。

## 依赖

**没有 npm 依赖。** 纯 Markdown，由 App 侧解包，不经过 pnpm。
