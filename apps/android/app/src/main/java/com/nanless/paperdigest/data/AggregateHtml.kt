package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import java.net.URI
import java.time.Instant

/** Independent aggregate-only parse. Actual raw and derived bytes have distinct identities. No resource request occurs. */
object AggregateHtml {
    private val allowed=("div p span a h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code table thead tbody tfoot tr th td caption img figure figcaption strong b em i u s sup sub br hr details summary dl dt dd math mrow mi mo mn msup msub msubsup mfrac msqrt mroot mtext mtable mtr mtd mover munder munderover semantics annotation").split(' ').toSet()
    private val attrs=("id class title alt width height colspan rowspan scope display mathvariant xmlns encoding").split(' ').toSet()
    private fun safeURL(raw:String,base:String):String?=runCatching{URI(base).resolve(raw).takeIf{it.scheme=="https"&&it.host!=null&&it.rawUserInfo==null}?.toASCIIString()}.getOrNull()
    private fun clean(root:Element,base:String,depth:Int=0){require(depth<=128);root.childNodes().toList().forEach{if(it is org.jsoup.nodes.Comment)it.remove()};root.children().toList().forEach{e->val tag=e.normalName();if(tag !in allowed){e.remove();return@forEach};e.attributes().asList().forEach{a->val name=a.key.lowercase();when {name=="href"&&tag=="a"->{if(a.value.startsWith('#'))Unit else{val url=safeURL(a.value,base);if(url==null)e.removeAttr(a.key)else e.attr(a.key,url)}};name=="src"&&tag=="img"->e.removeAttr(a.key);name !in attrs->e.removeAttr(a.key)}};if(tag=="a")e.attr("rel","noopener noreferrer");clean(e,base,depth+1)}}
    private fun plainText(body:Element):String {
        val copy=body.clone()
        copy.select(".katex").forEach{if(it.selectFirst("math")!=null)it.select(".katex-html").remove()}
        copy.select("math").toList().forEach{math->val tex=math.selectFirst("annotation[encoding=application/x-tex]")?.wholeText()?.takeIf{it.isNotBlank()};val value=if(tex!=null)"[公式 TeX：$tex]"else"[公式 MathML：${math.outerHtml()}]";math.replaceWith(org.jsoup.nodes.TextNode(value))}
        return copy.wholeText()
    }
    fun parse(raw:ByteArray,descriptor:PublishedAggregate,responseURL:String,fetchedAt:String):JSONObject {
        require(raw.size in 1..16*1024*1024);val source=PublishedAggregateReader.pageURL(descriptor.sourceURL);require(responseURL==source);Instant.parse(fetchedAt)
        val html=PublishedUtf8.decode(raw);require(!html.contains("<!ENTITY",true));val doc=Jsoup.parse(html,source)
        val canonical=doc.select("link").filter{it.attr("rel").equals("canonical",true)};require(canonical.size<=1);canonical.firstOrNull()?.let{require(PublishedAggregateReader.pageURL(it.attr("href"))==source)}
        val selector=when(descriptor.kind){"daily","conference"->"div#article-body.post-content";"page"->if(URI(source).rawPath=="/audio-paper-digest-blog/conferences/")"#conference-directory.conference-directory" else "div.reader-guide-content.post-content";else->error("invalid aggregate kind")}
        val nodes=doc.select(selector);require(nodes.size==1){"汇总正文结构缺失或重复"};val body=nodes.single();body.select("[hidden]").remove()
        // Jsoup preserves ordinary HTML5 containers; replace their names before applying the shared shape policy.
        body.select("section,article,main").forEach{it.tagName("div")}
        val resources=body.select("img").map{image->val rawSource=image.attr("src");val valid=safeURL(rawSource,source);JSONObject().put("sourceURL",valid?:rawSource).put("kind","image").put("missingReason",if(valid==null)"原图片地址不受本入口支持，未下载或隐藏缺项"else"尚未保存该图片；没有声称完整离线")};require(resources.size<=128)
        clean(body,source);val plain=plainText(body);require(plain.isNotBlank()){"汇总缺少连续正文"};val derived=body.html()
        return JSONObject().put("contract","published-aggregate-document-v1").put("descriptor",descriptor.json()).put("responseURL",responseURL).put("fetchedAt",fetchedAt).put("rawHTMLSHA256",PublishedAggregateReader.sha(raw)).put("rawHTMLBytes",raw.size).put("sanitizedBodySHA256",PublishedAggregateReader.sha(derived.toByteArray())).put("bodyHTML",derived).put("plainText",plain).put("parserContract","published-aggregate-jsoup-v1").put("resources",JSONArray(resources)).put("completeOffline",false).put("notices",JSONArray(listOf("网站汇总只读正文；不具有单篇论文、PDF、模型或Zotero资格。","原HTML与派生正文分别保存；目录当前性不代表旧网页已重新核验。")))
    }
    /** Independent resource derivation; the original parse/document bytes remain unchanged. */
    fun imagePlan(raw:ByteArray,descriptor:PublishedAggregate,responseURL:String,fetchedAt:String):AggregateImagePlan {
        val original=parse(raw,descriptor,responseURL,fetchedAt)
        val source=descriptor.sourceURL;val doc=Jsoup.parse(PublishedUtf8.decode(raw),source)
        val selector=when(descriptor.kind){"daily","conference"->"div#article-body.post-content";"page"->if(URI(source).rawPath=="/audio-paper-digest-blog/conferences/")"#conference-directory.conference-directory"else"div.reader-guide-content.post-content";else->error("invalid aggregate kind")}
        val body=doc.select(selector).single();body.select("[hidden]").remove();body.select("section,article,main").forEach{it.tagName("div")}
        val originalSources=java.util.IdentityHashMap<Element,String>()
        body.select("img").forEach{originalSources[it]=it.attr("src")}
        clean(body,source)
        val slots=body.select("img").mapIndexed{i,image->
            val address=originalSources[image].orEmpty();val caption=image.parents().firstOrNull{it.normalName()=="figure"}?.select("figcaption")?.joinToString("\n"){it.wholeText()}?.trim().orEmpty()
            AggregateImageSlot(i,safeURL(address,source),image.attr("alt"),caption)
        }
        require(slots.size<=128)
        return AggregateImagePlan(descriptor,original.getString("rawHTMLSHA256"),original.getString("sanitizedBodySHA256"),slots,body.html())
    }

}
