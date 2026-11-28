package com.dsh.android.runtime

/**
 * 由 App 播种的内置 overlay（`--patch` 层）。
 *
 * 为什么放在 App 而不是 profile：
 * `profiles/web/cordis.patch.yml` 属于**用户配置层**（DSH 初始化会写、用户/其他 agent 也会改、
 * runtime 升级可能重整）；`--patch` overlay 由本 App 独占，优先级更高，且**删文件即回退**。
 * 现有先例：`session-search.patch.yml`（启用会话全文检索）。
 */
object BuiltinOverlays {

    /** 统计面板 overlay 的文件名（落在 `$DSH_HOME` 下）。 */
    const val UI_STATS_FILE = "ui-stats.patch.yml"

    /** 官方统计面板插件：Chat / Trajectory 旁多一个「统计」tab。 */
    const val UI_STATS_PLUGIN = "@deepseek-ai/dsh-experimental-client-ui-stats"

    /**
     * 统计面板的 patch 文本。
     *
     * 插件本体已经在 runtime 的 `node_modules` 里（版本与引擎一致），launch env 也带了
     * `NODE_PATH=/opt/dsh/node_modules`，所以**不需要 npm install**，只要在这里挂一条 entry。
     * 它 inject 的是 `ui-conversation` / `ui-renderer` / `api-session-controller` / `client-locale`，
     * 四者都是同版本的 rootfs 包。
     */
    fun uiStatsYaml(): String = buildString {
        append("# 由 DSH Android 客户端播种：启用官方统计面板（会话统计 / Token 用量）。\n")
        append("# 删掉本文件后重启引擎，即回退到「没有统计 tab」的出厂形态。\n")
        append("- id: ui-stats\n")
        append("  name: '")
        append(UI_STATS_PLUGIN)
        append("'\n")
    }
}
