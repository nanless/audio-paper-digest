package com.nanless.paperdigest.ui

import android.content.Context
import com.nanless.paperdigest.data.Article
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.commonmark.Extension
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.parser.Parser
import org.commonmark.renderer.html.HtmlRenderer
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import java.io.ByteArrayInputStream
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Only this isolated document executes fixed bundled KaTeX. Published reading views never execute JavaScript. */
object ResearchRenderer {
    data class Formula(val token: String, val tex: String, val display: Boolean)
    data class Prepared(val html: String, val formulae: List<Formula>)
    /** Same delimiter/escape rules as the current Mac scientificMathAt, without interpreting HTML or attributes. */
    internal data class ScientificMath(val start:Int,val end:Int,val text:String,val display:Boolean,val raw:String)
    private fun escapedAt(text:String,index:Int):Boolean {var slashes=0;var i=index-1;while(i>=0&&text[i]=='\\'){slashes++;i--};return slashes%2==1}
    internal fun scientificMathAt(text:String,start:Int):ScientificMath? {
        if(start !in text.indices||escapedAt(text,start))return null
        val open:String;val close:String;val display:Boolean
        when {
            text.startsWith("\\[",start)->{open="\\[";close="\\]";display=true}
            text.startsWith("\\(",start)->{open="\\(";close="\\)";display=false}
            text.startsWith("$$",start)->{open="$$";close="$$";display=true}
            text[start]=='$'->{open="$";close="$";display=false}
            else->return null
        }
        var end=start+open.length
        while(end<text.length){
            if(!display&&text[end]=='\n')return null
            if(text.startsWith(close,end)&&!escapedAt(text,end)&&end>start+open.length)return ScientificMath(start,end+close.length,text.substring(start+open.length,end),display,text.substring(start,end+close.length))
            end++
        }
        return null
    }
    internal data class TokenizedText(val text:String,val formulae:List<Formula>)
    private fun tokenizeHTMLText(text:String):TokenizedText {
        require(text.length<=1_000_000){"原文文字超过安全渲染上限"}
        val prefix="PDMATH${UUID.randomUUID().toString().replace("-", "")}X";val output=StringBuilder();val formulae=mutableListOf<Formula>();var i=0
        while(i<text.length){val match=scientificMathAt(text,i);if(match==null){output.append(text[i++]);continue}
            require(match.text.length<=12000&&formulae.size<256){"原文公式超过安全渲染上限"}
            val token="$prefix${formulae.size}END";formulae+=Formula(token,match.text,match.display);output.append(token);i=match.end
        }
        return TokenizedText(output.toString(),formulae)
    }
    fun prepare(markdown: String, images: Map<String,String> = emptyMap()): Prepared {
        require(markdown.length <= 1_000_000) { "研究内容超过显示上限，请导出原始记录查看" }
        val prefix = "PDMATH${UUID.randomUUID().toString().replace("-", "")}X"
        val formulas = mutableListOf<Formula>(); val output = StringBuilder()
        var i = 0; var fence: String? = null; var inlineTicks = 0
        while (i < markdown.length) {
            if ((i == 0 || markdown[i - 1] == '\n') && (markdown.startsWith("```", i) || markdown.startsWith("~~~", i))) {
                val marker = markdown.substring(i, i + 3); fence = if (fence == marker) null else if (fence == null) marker else fence
                val end = markdown.indexOf('\n', i).let { if (it < 0) markdown.length else it + 1 }
                output.append(markdown.substring(i, end)); i = end; continue
            }
            if (fence != null) { output.append(markdown[i++]); continue }
            if (markdown[i] == '`') {
                var j = i; while (j < markdown.length && markdown[j] == '`') j++
                val n = j - i; inlineTicks = if (inlineTicks == n) 0 else if (inlineTicks == 0) n else inlineTicks
                output.append(markdown.substring(i, j)); i = j; continue
            }
            if (inlineTicks == 0) {
                val match=scientificMathAt(markdown,i)
                if(match!=null){
                    require(match.text.length<=12000&&formulas.size<256){"公式超过安全渲染上限，请查看原始 Markdown"}
                    val token="$prefix${formulas.size}END";formulas+=Formula(token,match.text,match.display)
                    output.append(token);i=match.end;continue
                }
            }
            output.append(markdown[i++])
        }
        val extensions: List<Extension> = listOf(TablesExtension.create())
        val html = HtmlRenderer.builder().extensions(extensions).escapeHtml(true).sanitizeUrls(false).build()
            .render(Parser.builder().extensions(extensions).build().parse(output.toString()))
        // Remote images cannot quietly escape the offline reader; their original text remains in source exports.
        val doc = Jsoup.parseBodyFragment(html)
        doc.select("a[href]").forEach { link ->
            val href=link.attr("href")
            val safe=href.startsWith("#")||runCatching{val uri=java.net.URI(href);uri.scheme=="https"&&uri.host!=null&&uri.userInfo==null}.getOrDefault(false)
            if(!safe)link.removeAttr("href")
        }
        doc.select("img").forEach { image ->
            val original=image.attr("src");val inline=images[original].orEmpty()
            if(inline.matches(Regex("data:image/(png|jpeg|webp|gif|svg\\+xml);base64,[A-Za-z0-9+/=\\r\\n]+")))image.attr("src",inline)
            else image.replaceWith(org.jsoup.nodes.Element("span").text("[图片未离线保存：${image.attr("alt")}]"))
        }
        return Prepared(doc.body().html(), formulas)
    }

    suspend fun render(context: Context, markdown: String): String = renderPrepared(context,withContext(Dispatchers.Default){prepare(markdown)})

    suspend fun renderArticle(context:Context,article:Article):String = withContext(Dispatchers.Default) {
        if(!article.markdown.isNullOrEmpty()) {
            val compact=compactVerifiedImageData(article.markdown,article.inlineImages)
            return@withContext renderPrepared(context,prepare(compact.markdown,compact.images))
        }
        val document=Jsoup.parseBodyFragment(article.html)
        val verified=article.inlineImages.values.toSet()
        document.select("img").forEach{image->
            val original=image.attr("src").ifBlank{image.attr("data-source-url")};val inline=article.inlineImages[original]?:original.takeIf{it in verified}
            if(inline!=null){image.attr("src",inline).removeAttr("srcset").attr("loading","lazy")}
            else image.replaceWith(org.jsoup.nodes.Element("span").attr("role","note").attr("data-source-url",original).text("[图片未核验离线保存：${image.attr("alt")}]"))
        }
        renderHTMLMath(context,document)
    }

    /** Typed aggregate display only. It grants no paper, article, model, or source authority. */
    suspend fun renderAggregateHTML(context:Context,document:com.nanless.paperdigest.data.AggregateDocumentView,requireCurrent:()->Unit):String =
        renderAggregateBound(document,requireCurrent){html->
            withContext(Dispatchers.Default){renderHTMLMath(context,Jsoup.parseBodyFragment(html),"<p role='note'>部分原始 MathML 未携带 TeX；已保留原结构，请对照网站原页核对。</p>")}
        }

    /** Owner checks bracket the real asynchronous renderer, including cancellation/late completion. */
    internal suspend fun renderAggregateBound(document:com.nanless.paperdigest.data.AggregateDocumentView,requireCurrent:()->Unit,render:suspend(String)->String):String {
        requireCurrent()
        val rendered=render(document.images?.bodyHTML?:document.bodyHTML)
        requireCurrent()
        return rendered
    }

    internal data class TextTarget(val node:org.jsoup.nodes.TextNode,val tokenized:TokenizedText,val firstFormula:Int)
    internal data class HTMLMathPlan(val document:org.jsoup.nodes.Document,val targets:List<org.jsoup.nodes.Element>,val formulae:List<Formula>,val textTargets:List<TextTarget>,val missingAnnotation:Boolean)
    internal fun prepareHTMLMath(html:String):HTMLMathPlan = prepareHTMLMath(Jsoup.parseBodyFragment(html))
    private fun prepareHTMLMath(document:org.jsoup.nodes.Document):HTMLMathPlan {
        val targets=mutableListOf<org.jsoup.nodes.Element>();val formulas=mutableListOf<Formula>()
        val seen=mutableSetOf<org.jsoup.nodes.Element>();var missing=false
        document.select("math").forEach { math ->
            val annotation=math.selectFirst("annotation[encoding=application/x-tex]")
            if(annotation==null){missing=true;return@forEach}
            val target=math.closest(".katex-display")?:math.closest(".katex")?:math
            if(seen.add(target)){
                val tex=annotation.wholeText();require(tex.length<=12000&&formulas.size<256){"原文公式超过安全渲染上限"}
                targets.add(target);formulas+=Formula("",tex,math.attr("display")=="block"||target.hasClass("katex-display"))
            }
        }
        val textTargets=mutableListOf<TextTarget>()
        document.body().getAllElements().flatMap{it.textNodes()}.forEach{node->
            val parent=node.parent() as? org.jsoup.nodes.Element
            val isProtected=parent==null||(listOf(parent)+parent.parents()).any{it.tagName() in setOf("code","pre","script","style","math","annotation","annotation-xml")||it.hasClass("katex-html")||it in seen}
            if(!isProtected){
                val text=node.wholeText
                if(text.contains('\\')||text.contains('$')){
                    val tokenized=tokenizeHTMLText(text)
                    if(tokenized.formulae.isNotEmpty()){
                        require(formulas.size+tokenized.formulae.size<=256){"原文公式超过安全渲染上限"}
                        textTargets+=TextTarget(node,tokenized,formulas.size);formulas+=tokenized.formulae
                    }
                }
            }
        }
        return HTMLMathPlan(document,targets,formulas,textTargets,missing)
    }

    private suspend fun renderHTMLMath(context:Context,document:org.jsoup.nodes.Document,missingNotice:String="<p role='note'>部分原始 MathML 未携带 TeX；已保留原结构，旧版 Android WebView 可能无法正确排版，请对照 PDF 原文。</p>"):String {
        val plan=prepareHTMLMath(document)
        val targets=plan.targets;val formulas=plan.formulae;val textTargets=plan.textTargets;val missing=plan.missingAnnotation
        if(formulas.isNotEmpty()) {
            val rendered=renderFormulae(context,formulas)
            targets.forEachIndexed { i,target ->
                val replacement=Jsoup.parseBodyFragment(rendered[i])
                if(target.id().isNotBlank())replacement.body().children().firstOrNull()?.attr("id",target.id())
                target.before(replacement.body().html());target.remove()
            }
            textTargets.forEach{target->
                val holder=org.jsoup.nodes.Element("span").appendChild(org.jsoup.nodes.TextNode(target.tokenized.text))
                replaceFormulaTokens(holder,target.tokenized.formulae,rendered.subList(target.firstFormula,target.firstFormula+target.tokenized.formulae.size))
                holder.childNodes().toList().forEach{target.node.before(it)};target.node.remove()
            }
        }
        val notice=if(missing)missingNotice else ""
        return notice+(if(formulas.isNotEmpty())style(context)else "")+document.body().html()
    }

    private suspend fun renderPrepared(context:Context,prepared:Prepared):String = withContext(Dispatchers.Default) {
        if(prepared.formulae.isEmpty())return@withContext prepared.html
        val results=renderFormulae(context,prepared.formulae)
        val doc = Jsoup.parseBodyFragment(prepared.html)
        replaceFormulaTokens(doc.body(),prepared.formulae,results)
        style(context)+doc.body().html()
    }

    /** Reuses the same trusted KaTeX output replacement for Markdown and original HTML text fragments. */
    private fun replaceFormulaTokens(root:org.jsoup.nodes.Element,formulae:List<Formula>,results:List<String>){
        formulae.forEachIndexed { n, formula ->
            val textNodes = root.getAllElements().flatMap { it.textNodes() }.filter { it.wholeText.contains(formula.token) }
            textNodes.forEach { node ->
                val parts = node.wholeText.split(formula.token)
                parts.forEachIndexed { index, text ->
                    node.before(org.jsoup.nodes.TextNode(text))
                    if (index < parts.lastIndex) Jsoup.parseBodyFragment(results[n]).body().childNodes().toList().forEach { node.before(it) }
                }
                node.remove()
            }
        }
    }

    @Volatile private var bundledStyle:String?=null
    private suspend fun style(context:Context):String=bundledStyle?:withContext(Dispatchers.IO){
        var css=context.assets.open("katex/katex.min.css").bufferedReader().use{it.readText()}
        css=css.replace(Regex(",url\\(fonts/[^)]+\\.(?:woff|ttf)\\) format\\(\"[^\"]+\"\\)"),"")
        css=Regex("url\\(fonts/([A-Za-z0-9_-]+\\.woff2)\\)").replace(css){match->
            val bytes=context.assets.open("katex/fonts/${match.groupValues[1]}").use{it.readBytes()}
            "url(data:font/woff2;base64,${android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP)})"
        }
        require(!css.contains("url(fonts/")){"公式字体材料不完整"}
        ("<style>"+css+".katex-display{overflow-x:auto;overflow-y:hidden;padding:.3em 0}</style>").also{bundledStyle=it}
    }

    private suspend fun renderFormulae(context:Context,formulae:List<Formula>):List<String> {
        val katex = withContext(Dispatchers.IO) { context.assets.open("katex/katex.min.js").bufferedReader().use { it.readText() } }
        val source = JSONArray(formulae.map { JSONObject().put("tex", it.tex).put("display", it.display) }).toString()
            .replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        val results = withContext(Dispatchers.Main) {
            withTimeoutOrNull(15_000) {
                suspendCancellableCoroutine<List<String>> { continuation ->
                    val web = WebView(context.applicationContext)
                    web.settings.apply { javaScriptEnabled = true; allowFileAccess = false; allowContentAccess = false; blockNetworkLoads = true; domStorageEnabled = false }
                    var finished = false
                    fun destroy() { web.stopLoading(); web.destroy() }
                    continuation.invokeOnCancellation { android.os.Handler(android.os.Looper.getMainLooper()).post { if (!finished) { finished = true; destroy() } } }
                    web.webViewClient = object : WebViewClient() {
                        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse = WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(byteArrayOf()))
                        override fun onPageFinished(view: WebView?, url: String?) {
                            if (finished || !continuation.isActive) return
                            web.evaluateJavascript("JSON.stringify(window.rendered)") { encoded ->
                                if (finished || !continuation.isActive) return@evaluateJavascript
                                finished = true
                                try {
                                    val inner = JSONArray("[$encoded]").getString(0)
                                    val result = JSONObject(inner)
                                    require(!result.has("error")) { "公式无法正确渲染，请查看原始 Markdown" }
                                    val array = result.getJSONArray("html")
                                    require(array.length() == formulae.size)
                                    continuation.resume((0 until array.length()).map { array.getString(it) })
                                } catch (_: Exception) { continuation.resumeWithException(IllegalArgumentException("公式无法正确渲染，未将原文误报为成功")) }
                                finally { destroy() }
                            }
                        }
                    }
                    val html = "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'\"><script>$katex</script><script>try{window.rendered={html:($source).map(x=>katex.renderToString(x.tex,{displayMode:x.display,output:'htmlAndMathml',throwOnError:true,trust:false,maxExpand:1000,maxSize:20}))}}catch(e){window.rendered={error:true}}</script>"
                    web.loadDataWithBaseURL("https://renderer.invalid/", html, "text/html", "UTF-8", null)
                }
            } ?: throw IllegalArgumentException("公式渲染超时，原始资料仍保留；请对照 PDF 或导出 Markdown")
        }
        return results
    }
}
