package com.nanless.paperdigest.ui

import com.nanless.paperdigest.data.Article
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.data.AggregateBrowseState
import com.nanless.paperdigest.pdf.PdfOriginalSnapshot
import com.nanless.paperdigest.pdf.PdfDocumentRef
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.Deferred
import android.net.Uri
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject

/** Each emitted JSON value is an immutable snapshot; services own the records. */
data class UiState(
    val papers: List<Paper> = emptyList(),
    val offlinePaperIDs: Set<String> = emptySet(),
    val selectedPaperId: String? = null,
    val viewedPaper: Paper? = null,
    val readingMaterialID: String = "",
    val article: Article? = null,
    val pdfMode: Boolean = false,
    val pdfDocument: PdfDocumentRef? = null,
    val pdfPage: Int = 1,
    val pdfReceipt: JSONObject = JSONObject(),
    val pdfSelection: PdfSelection? = null,
    val pdfUnlockPrompt: PdfUnlockPrompt? = null,
    val settings: JSONObject = JSONObject(),
    val personal: JSONObject = JSONObject(),
    val cloud: JSONObject = JSONObject(),
    val zotero: JSONObject = JSONObject(),
    val jobs: List<JSONObject> = emptyList(),
    val pendingExports: List<JSONObject> = emptyList(),
    val pendingExportsError: String? = null,
    val pendingExportsLoading: Boolean = true,
    val retainedExportConfirmation: JSONObject? = null,
    val sessions: List<JSONObject> = emptyList(),
    val loading: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val catalogSyncedAt: String? = null,
    val catalogSummary: JSONObject = JSONObject(),
    val storageWarning: String? = null,
    val aggregate: AggregateBrowseState = AggregateBrowseState(),
)

enum class SecretKind { MODEL, ZOTERO, ZOTERO_DAV, CLOUD }

data class AggregateViewLease(val navigationEpoch:Long,val readingEpoch:Long)

interface AppController {
    /** Synchronous display-effect guard; never accepts a URL or grants a source capability. */
    fun aggregateLinkIsCurrent(nonce:String,index:Int):Boolean=false
    fun captureAggregateView():AggregateViewLease=AggregateViewLease(0,0)
    fun enterAggregateView() {}
    fun leaveAggregateView() {}
    fun retireAggregateView() {}
    suspend fun executeAggregateInView(command:String,payload:JSONObject,lease:AggregateViewLease):JSONObject=execute(command,payload)
    val state: StateFlow<UiState>
    /** Returns only actual service results. Unknown commands must fail visibly. */
    suspend fun execute(command: String, payload: JSONObject = JSONObject()): JSONObject
    /** Native-only capability; the expected view token can reject a stale tap, never select a file. */
    suspend fun prepareOriginalPdfOutput(expectedReadingMaterialID: String): PdfOriginalSnapshot =
        throw IllegalStateException("当前原文输出入口不可用，请重新打开原文后重试")
    /** Synchronously transfers the picker list to the Application; a UI coroutine only awaits this owned work. */
    fun importPdfs(uris: List<Uri>): Deferred<JSONObject> =
        throw IllegalStateException("当前 PDF 批次入口不可用，请重新选择原件")
    /** Only a current native request may consume the short-lived array; implementations erase it. */
    suspend fun unlockPdf(requestID: String, password: CharArray) {
        password.fill('\u0000')
        throw IllegalStateException("当前原文解锁入口不可用，请重新打开原件")
    }
    /** Request stopping the original native scope; the prompt stays until its actual parser drains. */
    suspend fun cancelPdfUnlock(requestID: String): Unit =
        throw IllegalStateException("当前原文解锁请求已结束")
    /** Secret values never enter general command JSON, settings or task logs. */
    suspend fun updateSecret(kind: SecretKind, value: String?)
    /** Originates solely from the current native PDF component. */
    suspend fun updatePdfSelection(selection: PdfSelection)
}
