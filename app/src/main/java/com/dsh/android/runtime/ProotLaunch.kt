package com.dsh.android.runtime

/** Pure launch-template transformations shared by web, rescue and diagnostic commands. */
internal object ProotLaunch {
    fun quote(value: String): String = "'" + value.replace("'", "'\"'\"'") + "'"

    fun template(
        source: List<String>,
        profile: String,
        originalPid: String,
        pid: String,
        patches: List<String>,
        command: List<String>? = null,
    ): List<String> {
        require(Regex("[A-Za-z0-9][A-Za-z0-9._-]*").matches(profile)) { "Invalid profile name" }
        val env = source.indexOf("{GUEST_ENV}")
        require(env >= 0 && source.count { it == "{GUEST_ENV}" } == 1) { "Missing guest env anchor" }
        require(source.count { it == "/usr/bin/env" } == 1) { "Missing env command anchor" }
        require(source.any { it.contains("{PATCHES}") }) { "Missing patches anchor" }
        require(source.drop(env + 1).take(2) == listOf("/bin/sh", "-c")) { "Unexpected guest command" }
        require(source.size == env + 4) { "Unexpected launch template tail" }
        val patchArgs = patches.joinToString(" ") { "--patch " + quote(it) }
        val script = if (command != null) {
            require(command.isNotEmpty())
            "echo \$\$ > ${quote(pid)}; exec " + command.joinToString(" ", transform = ::quote)
        } else {
            val old = "/usr/local/bin/dsh web {PATCHES}"
            val raw = source.last()
            require(raw.contains(old) && raw.contains(originalPid)) { "Unexpected web launch anchor" }
            raw.replace(old, "/usr/local/bin/dsh --profile ${quote(profile)} {PATCHES}")
                .replace(originalPid, quote(pid))
                .replace("{PATCHES}", patchArgs)
        }
        return source.take(env + 1) + listOf("/bin/sh", "-c", script)
    }
}