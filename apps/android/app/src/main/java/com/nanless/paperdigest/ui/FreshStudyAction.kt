package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.nanless.paperdigest.data.canonical
import com.nanless.paperdigest.data.sha256
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

private data class FreshStudyUiStamp(val check: Boolean, val owner: String?, val material: String, val pdf: String?, val page: Int?,
    val selection: PdfSelection?, val draft: String, val settings: String, val revision: Long) {
    override fun toString() = "FreshStudyUiStamp[redacted]"
}

/** The old Send retains reuse. This separate action must obtain a source-bound native confirmation. */
@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun FreshStudyAction(state: UiState, controller: AppController, draft: JSONObject = JSONObject(), connectionCheck: Boolean = false,
    draftRevision: Long = 0, enabled: Boolean = true, label: String = "另建一次研究…") {
    val scope = rememberCoroutineScope()
    val configuration = JSONObject().apply { listOf("endpoint", "model", "protocol", "httpProxy", "maxTokens", "timeoutMs", "responsesStream", "reasoningEffort", "dailyRequests", "offlineMode").forEach { if (state.settings.has(it)) put(it, state.settings.get(it)) } }
    val kind = draft.optString("evidenceKind", "guide")
    val stamp = FreshStudyUiStamp(connectionCheck, if (connectionCheck) null else state.selectedPaperId, if (connectionCheck) "" else state.readingMaterialID,
        if (!connectionCheck && kind != "guide") state.pdfDocument?.sha256 else null, if (!connectionCheck && kind == "page") state.pdfPage else null,
        if (!connectionCheck && kind == "selection") state.pdfSelection else null, if (connectionCheck) "connection-check" else canonical(draft), canonical(configuration), draftRevision)
    val latest by rememberUpdatedState(stamp)
    var requestID by remember { mutableStateOf<String?>(null) }
    var preparing by remember { mutableStateOf(false) }
    var committing by remember { mutableStateOf(false) }
    var commitID by remember { mutableStateOf<String?>(null) }
    var preview by remember { mutableStateOf<JSONObject?>(null) }
    var captured by remember { mutableStateOf<FreshStudyUiStamp?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var requestJob by remember { mutableStateOf<Job?>(null) }
    var active by remember { mutableStateOf(true) }
    fun discard(value: JSONObject?) {
        val id = value?.optString("confirmationID")?.takeIf { it.isNotEmpty() } ?: return
        scope.launch { runCatching { controller.execute("model.fresh.discard", obj("confirmationID" to id)) } }
    }
    fun retire() {
        val previous = preview
        requestID = null; preview = null; captured = null
        if (!committing) { requestJob?.cancel(); preparing = false }
        discard(previous)
    }
    LaunchedEffect(stamp) { if (captured != null && captured != stamp) { retire(); error = "问题、原文或模型设置已变化，请重新确认。" } }
    DisposableEffect(Unit) { onDispose { active = false; requestID = null; requestJob?.cancel() } }
    OutlinedButton({
        val submitted = stamp
        val nonce = UUID.randomUUID().toString()
        requestID = nonce; preparing = true; error = null; notice = null
        val payload = if (connectionCheck) JSONObject() else JSONObject(draft.toString()).put("readingMaterialID", state.readingMaterialID)
        val expected = if (connectionCheck) obj("evidenceKind" to "connection-check", "force" to true) else JSONObject(draft.toString()).put("force", true)
        val expectedDraft = sha256(canonical(expected).toByteArray())
        val expectedQuestion = if (connectionCheck) "检查当前模型连接" else draft.getString("question")
        val expectedModel = state.settings.optString("model").trim()
        requestJob = scope.launch {
            try {
                val result = controller.execute(if (connectionCheck) "model.fresh.check.prepare" else "model.fresh.prepare", payload)
                if (active && requestID == nonce && latest == submitted) {
                    val id = result.getString("confirmationID")
                    require(UUID.fromString(id).toString() == id && result.getString("kind") == if (connectionCheck) "connection-check" else "study")
                    require(result.getString("draftIdentity") == expectedDraft)
                    require(result.getString("question") == expectedQuestion)
                    require(result.getString("model") == expectedModel)
                    preview = result; captured = submitted
                } else discard(result)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (active && requestID == nonce) error = "未能准备本次确认，请检查当前材料与设置。" }
            finally { if (requestID == nonce) preparing = false }
        }
    }, enabled = enabled && !state.busy && !preparing && !committing) { Text(if (preparing) "正在核对本次材料…" else label) }
    notice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    preview?.let { value ->
        val viewport = LocalConfiguration.current.screenHeightDp
        Dialog(onDismissRequest = { if (!committing) retire() }) {
            Surface(shape = MaterialTheme.shapes.extraLarge, tonalElevation = 6.dp) {
                Column(Modifier.fillMaxWidth().heightIn(max = (viewport * .90f).dp).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(if (connectionCheck) "检查当前模型连接" else "另建一次研究", style = MaterialTheme.typography.headlineSmall)
                    Text(value.optString("question")); Text(value.optString("scope")); Text("请求模型：${value.optString("model")}")
                    Text(value.optString("notice")); Text("保存或删除模型密钥后须重新确认；本次不会覆盖旧记录。", style = MaterialTheme.typography.bodySmall)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton({ retire() }, enabled = !committing) { Text("取消") }
                        Button({
                            val original = captured
                            if (original == null || latest != original) { retire(); error = "材料或问题已变化，请重新确认。" }
                            else {
                                val nonce = UUID.randomUUID().toString(); requestID = nonce; commitID = nonce; committing = true; error = null
                                requestJob = scope.launch {
                                    try {
                                        val result = controller.execute("model.fresh.commit", obj("confirmationID" to value.getString("confirmationID"), "draftIdentity" to value.getString("draftIdentity")))
                                        if (active && requestID == nonce) {
                                            preview = null; captured = null
                                            notice = if (result.optBoolean("queued")) if (connectionCheck) "本次连接检查已排队，请查看任务中的实际结果与用量。" else "已新建研究，请查看任务中的实际结果与用量。" else "本次操作未确认排队，请查看任务记录。"
                                        }
                                    } catch (cancelled: CancellationException) { throw cancelled }
                                    catch (_: Exception) { if (active && requestID == nonce) { preview = null; captured = null; error = "本次确认已失效或未完成，请重新核对后再操作；原记录保留。" } }
                                    finally { if (commitID == nonce) { committing = false; commitID = null } }
                                }
                            }
                        }, enabled = !committing && !state.busy && enabled && captured == stamp) { Text(if (committing) "正在登记…" else "确认新建并发送") }
                    }
                }
            }
        }
    }
}
