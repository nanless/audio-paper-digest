package com.nanless.paperdigest.data

import org.json.JSONObject
import java.net.URI

/** Presentation from the actual Article only; never a current-catalog lookup or source qualification. */
object PublishedSourceWarning {
    private fun text(value: Any?): String? = value as? String
    private fun nonempty(value: String?): String? = value?.takeIf { it.isNotBlank() }
    private fun address(value: String?): String? = nonempty(value)?.takeIf { runCatching { URI(it).let { u -> u.scheme == "https" && u.host != null && u.userInfo == null && u.port in listOf(-1, 443) } }.getOrDefault(false) }
    internal fun warning(article: Article): String? {
        val c=article.citation
        if(c.opt("contract") != "paper-citation-source-v1" || c.opt("verified") !is Boolean || c.opt("verified") != true || c.opt("identityStatus") != "verified" || nonempty(article.paperID)==null || c.opt("paperKey") != article.paperID)return null
        val warning=text(c.opt("sourceVersionWarning"))?.takeIf { it.isNotBlank() } ?: return null
        val blog=address(article.blogURL) ?: return null;val source=address(article.sourceURL) ?: return null
        if(c.opt("pageUrl") != blog || c.opt("sourceUrl") != source)return null
        for(key in listOf("paperId","url"))if(c.has(key) && c.opt(key) != if(key=="paperId")article.paperID else source)return null
        val declaredPDF=text(c.opt("pdfUrl")) ?: return null
        if(nonempty(declaredPDF)!=nonempty(article.pdfURL) || (nonempty(article.pdfURL)!=null && address(article.pdfURL)==null))return null
        val kind=nonempty(text(c.opt("sourceKind"))) ?: return null
        if(article.paperID.startsWith("arxiv:")){
            val version=nonempty(article.sourceVersion) ?: return null
            if(kind!="arxiv" || c.opt("arxivId")!=version || article.paperID!="arxiv:"+version.replace(Regex("v[1-9][0-9]*$"),""))return null
        }else {
            if(kind=="arxiv" || nonempty(article.sourceVersion)!=null)return null
            if(c.has("arxivId") && (c.opt("arxivId") !is String || nonempty(text(c.opt("arxivId")))!=null))return null
        }
        return warning
    }
    fun present(article: Article): Article {
        val notices=(article.notices + listOfNotNull(warning(article))).distinct()
        return if(notices==article.notices)article else article.copy(notices=notices)
    }
}
