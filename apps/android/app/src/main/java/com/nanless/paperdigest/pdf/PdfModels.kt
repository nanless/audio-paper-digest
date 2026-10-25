package com.nanless.paperdigest.pdf

/** Immutable original bytes. All page numbers exposed to the app are 1-based. */
/** PDF bookmark preorder index is zero-based; physical page ranges remain one-based and inclusive. */
data class PdfChapter(val index:Int,val title:String,val page:Int,val endPage:Int,val depth:Int=0)

data class PdfDocumentRef(val id: String, val localPath: String, val sha256: String, val pageCount: Int, val displayName: String)
data class PdfSelectionBounds(val page: Int, val left: Float, val top: Float, val right: Float, val bottom: Float)
data class PdfSelection(val documentSHA256: String, val text: String, val pages: List<Int>, val bounds: List<PdfSelectionBounds>, val coordinateSystem: String = "rotated-crop-top-left-points-v1", val extractor: String = "android-pdfbox-physical-pages-v1")
data class PdfTextSpan(val start: Int, val end: Int, val bounds: PdfSelectionBounds)
data class PdfPageText(val page: Int, val text: String, val width: Float, val height: Float, val spans: List<PdfTextSpan>)
data class PdfSearchMatch(val page: Int, val start: Int, val end: Int, val text: String, val bounds: List<PdfSelectionBounds>)
data class PdfEvidence(val documentSHA256: String, val kind: String, val pages: List<Int>, val text: String, val missingTextPages: List<Int>)
data class PdfAnnotation(val id: String, val selection: PdfSelection, val note: String, val createdAt: String)

object PdfTextSemantics {
    fun selection(sha: String, page: PdfPageText, start: Int, end: Int): PdfSelection {
        require(Regex("[a-f0-9]{64}").matches(sha)) { "PDF 来源校验无效" }
        require(page.page >= 1 && start >= 0 && end > start && end <= page.text.length) { "选区超出原始页面" }
        val text = page.text.substring(start, end)
        require(text.isNotBlank()) { "选区没有可提取的文字，未将图片冒充原文" }
        val bounds = page.spans.filter { it.end > start && it.start < end }.map { it.bounds }.distinct()
        return PdfSelection(sha, text, listOf(page.page), bounds)
    }
    fun search(pages: List<PdfPageText>, query: String): List<PdfSearchMatch> {
        require(query.isNotBlank() && query.length <= 1000) { "请输入1–1000字的查找内容" }
        return buildList {
            for (page in pages) {
                var offset = 0
                while (offset < page.text.length) {
                    val at = page.text.indexOf(query, offset, ignoreCase = true)
                    if (at < 0) break
                    val end = at + query.length
                    require(size<10000) { "匹配结果超过10000项，请输入更长的查找文字" }
                    add(PdfSearchMatch(page.page, at, end, page.text.substring(at, end), page.spans.filter { it.end > at && it.start < end }.map { it.bounds }.distinct()))
                    offset = end
                }
            }
        }
    }
}

/** Crop-relative display points (top-left) versus PDFKit's unrotated PDF user-space. */
data class PdfPageGeometry(val cropLeft:Float,val cropBottom:Float,val width:Float,val height:Float,val rotation:Int) {
    init {require(listOf(cropLeft,cropBottom,width,height).all{it.isFinite()} && width>0 && height>0 && rotation in listOf(0,90,180,270))}
}
data class PdfUserRect(val x:Float,val y:Float,val width:Float,val height:Float)
object PdfCoordinates {
    fun toUserSpace(b:PdfSelectionBounds,g:PdfPageGeometry):PdfUserRect {
        require(listOf(b.left,b.top,b.right,b.bottom).all{it.isFinite()} && b.right>=b.left && b.bottom>=b.top)
        val points=listOf(b.left to b.top,b.right to b.top,b.left to b.bottom,b.right to b.bottom).map{(x,y)->
            val p=when(g.rotation){0->x to g.height-y;90->y to x;180->g.width-x to y;else->g.width-y to g.height-x}
            p.first+g.cropLeft to p.second+g.cropBottom
        }
        val x=points.minOf{it.first};val y=points.minOf{it.second}
        return PdfUserRect(x,y,points.maxOf{it.first}-x,points.maxOf{it.second}-y)
    }
    fun toDisplaySpace(page:Int,r:PdfUserRect,g:PdfPageGeometry):PdfSelectionBounds {
        require(listOf(r.x,r.y,r.width,r.height).all{it.isFinite()} && r.width>=0 && r.height>=0)
        val points=listOf(r.x to r.y,r.x+r.width to r.y,r.x to r.y+r.height,r.x+r.width to r.y+r.height).map{(x,y)->
            val u=x-g.cropLeft;val v=y-g.cropBottom
            when(g.rotation){0->u to g.height-v;90->v to u;180->g.width-u to v;else->g.height-v to g.width-u}
        }
        return PdfSelectionBounds(page,points.minOf{it.first},points.minOf{it.second},points.maxOf{it.first},points.maxOf{it.second})
    }
}
