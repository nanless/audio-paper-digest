package com.nanless.paperdigest.data

/** The visible reading snapshot, never a lookup against the newest catalog row. */
internal data class GuidePrintReading(val materialID: String, val paper: Paper?, val article: Article?)

/** Currentness is checked both around scientific rendering and at the system handoff. */
internal class GuidePrintBinding(
    val paper: Paper, val article: Article, private val materialID: String,
    private val current: () -> GuidePrintReading,
) {
    init { require(materialID.isNotBlank()) { "请先载入当前论文的真实导读" }; ReadingSourceBinding.requireArticle(paper, article) }
    fun requireCurrent() {
        val now = current()
        require(now.materialID == materialID && now.paper?.id == paper.id && now.article != null) {
            "阅读材料已变化，请在当前论文重新打开打印预览"
        }
        ReadingSourceBinding.requireArticle(paper, article)
        ReadingSourceBinding.requireArticle(requireNotNull(now.paper), now.article)
        require(now.article.revisionSHA256 == article.revisionSHA256 && now.article.sourceURL == article.sourceURL &&
            now.article.sourceVersion == article.sourceVersion && now.article.blogURL == article.blogURL && now.article.pdfURL == article.pdfURL) {
            "图文导读修订已变化，请重新打开打印预览"
        }
    }
}
