package com.dsh.android.engine

/**
 * 引擎宿主链路的统一异常。
 *
 * P2（0.3.0-refactor.2）之后本地只有 PRoot 一个宿主（`ProotHost`）：原来的
 * `EngineHost` 抽象、`HostMode` 三值枚举、`TermuxBionicHost` / `ProotGlbcHost`
 * 两套宿主实现、`EngineBootGate` 的「起不来就回落 bionic」全部删除。
 *
 * 这里只保留异常类型 —— `PrivilegedRunner` / `McpWiring` / `AndroidCapabilitiesImpl`
 * 等仍用它表达失败，且错误信息是用户可见的第一手证据。
 */
class EngineHostException(message: String, cause: Throwable? = null) : Exception(message, cause)
