package com.nanless.paperdigest.data

import org.jsoup.Jsoup
import java.net.URI
import java.util.UUID

/** Display-only table minted from one native document, never deserialized from UI or backup JSON. */
internal class AggregateLinkTable private constructor(val nonce:String,val html:String,private val hrefs:List<String>) {
    fun href(index:Int):String?=hrefs.getOrNull(index)
    companion object {
        fun derive(document:AggregateDocumentView):AggregateLinkTable {
            val nonce=UUID.randomUUID().toString()
            val tree=Jsoup.parseBodyFragment(document.images?.bodyHTML?:document.bodyHTML,document.descriptor.sourceURL)
            tree.outputSettings().prettyPrint(false)
            val hrefs=ArrayList<String>()
            for(anchor in tree.select("a[href]")) {
                val href=anchor.attr("href")
                val target=runCatching{URI(document.descriptor.sourceURL).resolve(href)}.getOrNull()
                if(target==null||target.scheme!="https"||target.host==null||target.rawUserInfo!=null||target.host=="reader.invalid") {anchor.removeAttr("href");continue}
                val index=hrefs.size;hrefs+=target.toASCIIString()
                anchor.attr("href","https://reader.invalid/aggregate-link/$nonce/$index")
                anchor.removeAttr("target")
            }
            return AggregateLinkTable(nonce,tree.body().html(),hrefs.toList())
        }
    }
}

internal sealed class AggregateLinkDestination {
    data class Anchor(val rawFragment:String):AggregateLinkDestination()
    data class Aggregate(val id:String):AggregateLinkDestination()
    data class PublishedPaper(val paper:Paper):AggregateLinkDestination()
    data class External(val url:String):AggregateLinkDestination()
}

/** Narrow page equality: literal URL, or exactly one final slash; no query/origin/path aliases. */
internal object AggregateLinkRouting {
    fun samePage(candidate:String,known:String,source:String):Boolean=runCatching {
        if(candidate!=known&&candidate+"/"!=known&&known+"/"!=candidate)return false
        CatalogRepository.sameSite(candidate);CatalogRepository.sameSite(known)
        val a=URI(candidate);val b=URI(known);val origin=URI(source)
        a.host==b.host&&a.port==b.port&&a.scheme==b.scheme&&a.host==origin.host&&a.port==origin.port&&a.scheme==origin.scheme
    }.getOrDefault(false)
    suspend fun resolve(document:AggregateDocumentView,href:String,catalog:PublishedAggregateCatalog,papers:List<Paper>,verifiedOriginal:suspend(Paper)->Boolean,current:()->Boolean):AggregateLinkDestination {
        require(current()&&catalog.records.any{it==document.descriptor})
        val target=URI(href);require(target.scheme=="https"&&target.host!=null&&target.rawUserInfo==null&&target.host!="reader.invalid")
        val page=withoutFragment(target);val source=document.descriptor.sourceURL
        if(samePage(page,source,source))return AggregateLinkDestination.Anchor(target.rawFragment.orEmpty())
        // A query remains an ordinary browser address, never an alias for a native entry.
        if(target.rawQuery==null) {
            catalog.records.firstOrNull{samePage(page,it.sourceURL,source)}?.let {
                require(current());return AggregateLinkDestination.Aggregate(it.id)
            }
            val paper=papers.firstOrNull{p->p.identityStatus=="verified"&&(p.appearances+p.blogURL).any{samePage(page,it,source)}}
            if(paper!=null) {
                require(verifiedOriginal(paper)){"原目录论文记录尚未核验"}
                require(current());return AggregateLinkDestination.PublishedPaper(paper)
            }
        }
        require(current());return AggregateLinkDestination.External(href)
    }
    fun withoutFragment(uri:URI):String=uri.toASCIIString().substringBefore('#')
}
