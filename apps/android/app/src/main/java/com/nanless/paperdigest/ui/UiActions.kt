package com.nanless.paperdigest.ui

import com.nanless.paperdigest.data.Article
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.pdf.PdfDocumentRef
import com.nanless.paperdigest.pdf.PdfSelection
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
    val settings: JSONObject = JSONObject(),
    val personal: JSONObject = JSONObject(),
    val cloud: JSONObject = JSONObject(),
    val zotero: JSONObject = JSONObject(),
    val jobs: List<JSONObject> = emptyList(),
    val sessions: List<JSONObject> = emptyList(),
    val loading: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val catalogSyncedAt: String? = null,
    val catalogSummary: JSONObject = JSONObject(),
    val storageWarning: String? = null,
)

enum class SecretKind { MODEL, ZOTERO, CLOUD }

interface AppController {
    val state: StateFlow<UiState>
    /** Returns only actual service results. Unknown commands must fail visibly. */
    suspend fun execute(command: String, payload: JSONObject = JSONObject()): JSONObject
    /** Secret values never enter general command JSON, settings or task logs. */
    suspend fun updateSecret(kind: SecretKind, value: String?)
    /** Originates solely from the current native PDF component. */
    suspend fun updatePdfSelection(selection: PdfSelection)
}
