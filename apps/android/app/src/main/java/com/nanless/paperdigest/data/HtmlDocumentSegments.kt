package com.nanless.paperdigest.data

import com.nanless.paperdigest.ui.StreamedHtmlDocument

/** Export and system printing share the same immutable scientific body and wrapper. */
internal data class HtmlDocumentSegments(val head: String, val body: String, val tail: String) {
    fun asStreamedDocument(): StreamedHtmlDocument = StreamedHtmlDocument(head, body, tail)
    fun joinForExport(): String = head + body + tail

    companion object {
        fun create(title: String, body: String, notices: List<String> = emptyList()): HtmlDocumentSegments {
            // Preserve the existing export contract. This still has the existing
            // complete Jsoup title-probe cost; streaming removes output copies only.
            val hasTitle = title.isNotBlank() && org.jsoup.Jsoup.parseBodyFragment(body).body()
                .select("h1").any { it.text().isNotBlank() }
            val heading = if (title.isBlank() || hasTitle) "" else "<h1>${ExportService.escape(title)}</h1>"
            val prefix = ExportService.htmlDocumentHead(title) + heading +
                notices.joinToString("") { "<p role='note'>${ExportService.escape(it)}</p>" }
            return HtmlDocumentSegments(prefix, body, "</body></html>")
        }
    }
}
