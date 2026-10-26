package com.dsh.android.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.dsh.android.engine.HostCapabilities
import com.dsh.android.engine.HostMode
import com.dsh.android.engine.RootfsProvisioner
import com.dsh.android.engine.VerifyC
import kotlinx.coroutines.launch
import java.io.File

/**
 * 宿主设置页（Compose）。
 *
 * 设计取舍（借 Operit2 的「能力声明」思路）：
 *   · 先把 `HostCapabilities` 摊给用户看，再让他选——而不是选完发现不能用；
 *   · 装配与验收各给一个按钮，结果直接显示在卡片里（不让用户去翻日志）；
 *   · 不在这里做「下载」，只做「检查 + 跑脚本」，避免设置页藏一个长事务。
 */
@Composable
fun HostSettingsSection(
    filesDir: File,
    current: HostMode,
    capabilities: HostCapabilities,
    provisioner: RootfsProvisioner,
    verifier: VerifyC,
    workspace: File,
    onSelect: (HostMode) -> Unit,
    onOpenLogs: () -> Unit,
) {
    var busy by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("引擎宿主", style = MaterialTheme.typography.titleMedium)
        Text(
            capabilities.summary,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Card(colors = CardDefaults.cardColors()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                CapRow("platform", capabilities.platform)
                CapRow("内核级沙箱", if (capabilities.kernelSandbox) "可用" else "不可用（内核未编 userns/Landlock）")
                CapRow("用户态 runner", capabilities.sandboxRunner?.command?.firstOrNull() ?: "未配置")
                CapRow("原生预编译", capabilities.nativePrebuilds.name)
                CapRow("PTY / 图片", "${if (capabilities.pty) "✓" else "✗"} / ${if (capabilities.imagePipeline) "✓" else "✗"}")
                CapRow("PID 命名空间", if (capabilities.pidNamespace) "隔离" else "共享")
            }
        }

        Divider()

        HostMode.entries.forEach { mode ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = current == mode, onClick = { onSelect(mode) })
                Column(Modifier.padding(start = 4.dp)) {
                    Text(modeLabel(mode), style = MaterialTheme.typography.bodyLarge)
                    Text(modeHint(mode), style = MaterialTheme.typography.bodySmall)
                }
            }
        }

        Divider()

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                enabled = busy == null,
                onClick = {
                    busy = "provision"
                    scope.launch {
                        message = provisioner.provision().fold(
                            onSuccess = { it },
                            onFailure = { it.message ?: "装配失败" },
                        )
                        busy = null
                    }
                },
            ) { Text(if (busy == "provision") "装配中…" else "装配 glibc 环境") }

            OutlinedButton(
                enabled = busy == null,
                onClick = {
                    busy = "verify"
                    scope.launch {
                        val script = File(filesDir, "bin/verify-c.sh")
                        message = runCatching { verifier.run(script, workspace) }
                            .fold(
                                onSuccess = { r -> "验收 ${r.pass} 通过 / ${r.fail} 失败\n${r.logPath}" },
                                onFailure = { "验收失败：${it.message}" },
                            )
                        busy = null
                    }
                },
            ) { Text(if (busy == "verify") "验收中…" else "运行验收") }

            OutlinedButton(onClick = onOpenLogs) { Text("查看日志") }
        }

        message?.let {
            Spacer(Modifier.height(4.dp))
            Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
        }

        Divider()

        Text("装配前置", style = MaterialTheme.typography.titleSmall)
        provisioner.preflight().forEach { c ->
            Row(Modifier.fillMaxWidth()) {
                Text(if (c.ok) "✅" else "❌", modifier = Modifier.padding(end = 6.dp))
                Column {
                    Text(c.id, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                    if (!c.ok && c.fix.isNotEmpty()) {
                        Text(c.fix, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}

@Composable
private fun CapRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
    }
}

private fun modeLabel(mode: HostMode) = when (mode) {
    HostMode.TERMUX_BIONIC -> "Termux（bionic，现状）"
    HostMode.PROOT_GLIBC -> "proot（glibc，官方预编译）"
    HostMode.REMOTE -> "远端引擎"
}

private fun modeHint(mode: HostMode) = when (mode) {
    HostMode.TERMUX_BIONIC -> "原生模块需自备 android 产物；启动最快"
    HostMode.PROOT_GLIBC -> "flock/sharp/node-pty 官方预编译全可用；启动慢一次"
    HostMode.REMOTE -> "手机只做前端；能力取决于远端主机"
}