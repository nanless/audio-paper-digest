package com.nanless.paperdigest.pdf

import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import java.io.File
import java.util.UUID

/** Vector PDF pages are imported, never rasterized. Output is staged before the print spool receives it. */
object PdfOriginalWriter {
    fun write(snapshot:PdfOriginalSnapshot,ranges:List<PdfOutputRange>,parent:File,password:String="",check:()->Unit={}):PdfWrittenPages {
        snapshot.checkBytes(check);val selected=PdfOutputPages.resolve(snapshot.document.pageCount,ranges)
        require(parent.isDirectory&&!java.nio.file.Files.isSymbolicLink(parent.toPath())&&parent.absoluteFile==parent.canonicalFile)
        val output=File(parent,".print-"+UUID.randomUUID()+".pdf")
        try {
            PDDocument.load(snapshot.file,password,MemoryUsageSetting.setupMixed(8L*1024*1024,512L*1024*1024)).use{source->
                require(source.numberOfPages==snapshot.document.pageCount){"原文实际页数与打开记录不符"}
                require(source.currentAccessPermission.canPrint()){ "此原件的权限不允许打印；可以分享原始文件" }
                check()
                if(selected.size==source.numberOfPages&&!source.isEncrypted) {
                    snapshot.file.inputStream().use{input->output.outputStream().use{out->PdfOriginalSnapshot.copy(input,{b,n->out.write(b,0,n)},check)}}
                }else PDDocument(MemoryUsageSetting.setupMixed(8L*1024*1024,512L*1024*1024)).use{target->
                    for(index in selected){check();val page=source.getPage(index);val imported=target.importPage(page);imported.resources=page.resources;imported.rotation=page.rotation}
                    output.outputStream().use { raw->
                        var count=0L
                        val checked=object:java.io.FilterOutputStream(raw){
                            override fun write(b:Int){check();require(++count<=200L*1024*1024);out.write(b)}
                            override fun write(b:ByteArray,off:Int,len:Int){check();count+=len;require(count<=200L*1024*1024);out.write(b,off,len)}
                        }
                        target.save(checked);checked.flush()
                    }
                }
            }
            check();snapshot.checkBytes(check)
            PDDocument.load(output,MemoryUsageSetting.setupMixed(8L*1024*1024,512L*1024*1024)).use{require(it.numberOfPages==selected.size){"输出 PDF 页数校验失败"}}
            if(selected.size==snapshot.document.pageCount && PdfOriginalSnapshot.digest(snapshot.file)==PdfOriginalSnapshot.digest(output)) {
                return PdfWrittenPages(output,PdfOutputPages.compact(selected),true)
            }
            return PdfWrittenPages(output,PdfOutputPages.compact(selected),false)
        }catch(t:Throwable){output.delete();throw t}
    }
}
data class PdfWrittenPages(val file:File,val originalRanges:List<PdfOutputRange>,val exactOriginalBytes:Boolean)
