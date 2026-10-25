package com.nanless.paperdigest.pdf

/** Android's printing contract uses zero-based inclusive original document indices. */
data class PdfOutputRange(val first:Int,val last:Int) {
    init { require(first>=0 && last>=first) { "打印页范围无效" } }
}
object PdfOutputPages {
    fun resolve(pageCount:Int,ranges:List<PdfOutputRange>):List<Int> {
        require(pageCount in 1..100000 && ranges.isNotEmpty() && ranges.size<=100000) { "请选择有效的原文打印页" }
        val selected=BooleanArray(pageCount)
        for(r in ranges) {
            if(r.first>=pageCount)continue
            for(p in r.first..minOf(r.last,pageCount-1))selected[p]=true
        }
        return selected.indices.filter { selected[it] }.also { require(it.isNotEmpty()) { "所选打印页不在当前原文范围内" } }
    }
    fun compact(pages:List<Int>):List<PdfOutputRange> {
        require(pages.isNotEmpty() && pages.all{it>=0} && pages==pages.distinct().sorted()) { "打印页列表无效" }
        val result=mutableListOf<PdfOutputRange>();var start=pages.first();var last=start
        for(p in pages.drop(1))if(p==last+1)last=p else {result+=PdfOutputRange(start,last);start=p;last=p}
        result+=PdfOutputRange(start,last);return result
    }
}
