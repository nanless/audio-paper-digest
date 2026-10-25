package com.nanless.paperdigest.pdf

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.core.content.FileProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PdfRepositoryInstrumentedTest {
    @Test fun realPublishedPdfImportTextPhysicalSelectionEvidenceAndPersistentCoordinates()=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val sample=JSONObject(context.assets.open("published/sample.json").bufferedReader().use{it.readText()})
        val pdf=sample.getJSONObject("pdf");val expected=pdf.getString("sha256")
        val source=File(context.cacheDir,"Exports/fixture-${UUID.randomUUID()}.pdf");source.parentFile!!.mkdirs();context.assets.open("published/"+pdf.getString("src")).use{input->source.outputStream().use{input.copyTo(it)}}
        val root=File(context.cacheDir,"PdfRepository-QA-${UUID.randomUUID()}");val repo=PdfRepository(context,root)
        try{
            val original=source.readBytes();val uri=FileProvider.getUriForFile(context,context.packageName+".files",source)
            val document=repo.importPdf(uri)
            assertEquals(expected,document.sha256);assertEquals(13,document.pageCount);assertTrue(File(document.localPath).canonicalPath.startsWith(File(root,"Imports").canonicalPath+"/"));assertArrayEquals(original,source.readBytes())
            val actualOutline=repo.outline(document);assertEquals(actualOutline.indices.toList(),actualOutline.map{it.index});assertTrue(actualOutline.all{it.page in 1..13&&it.endPage in it.page..13});println("PUBLIC_MICLA_OUTLINE_COUNT ${actualOutline.size}")
            val pages=repo.readPages(document);assertEquals((1..13).toList(),pages.map{it.page});assertTrue(pages.joinToString(" "){it.text}.contains("MiCLA"));assertTrue(pages.any{it.spans.isNotEmpty()})
            val matches=repo.search(document,"MiCLA");assertTrue(matches.isNotEmpty());assertTrue(matches.all{it.page in 1..13&&it.bounds.isNotEmpty()})
            val first=matches.first();val selected=repo.select(document,first.page,first.start,first.end);assertEquals(first.text,selected.text);assertEquals(listOf(first.page),selected.pages);assertEquals(expected,selected.documentSHA256)
            val evidence=repo.evidence(document,first.page,first.page);assertTrue(evidence.text.contains("[原文物理页 ${first.page}]"));assertEquals(listOf(first.page),evidence.pages);assertEquals(expected,evidence.documentSHA256)
            try{repo.evidence(document,1,13,maxCharacters=5);fail("must reject instead of truncate")}catch(_:IllegalArgumentException){}
            val annotation=repo.saveAnnotation(document,selected,"真实原文坐标验收")
            val reopened=PdfRepository(context,root);assertEquals(listOf(annotation),reopened.loadAnnotations(document))
            val updated=reopened.updateAnnotation(document,annotation.id,"修改批注").single();assertEquals(annotation.selection,updated.selection);assertEquals(annotation.createdAt,updated.createdAt);assertEquals("修改批注",updated.note)
            assertTrue(reopened.removeAnnotation(document,annotation.id).isEmpty());assertArrayEquals(original,File(document.localPath).readBytes())
            val originalBytes=File(document.localPath).readBytes();File(document.localPath).appendText("tampered")
            try{reopened.readPages(document);fail("wrong actual PDF bytes must reject")}catch(_:IllegalArgumentException){}finally{File(document.localPath).writeBytes(originalBytes)}
            val invalid=source.resolveSibling("invalid-${UUID.randomUUID()}.pdf");invalid.writeText("not a PDF")
            try{repo.importFile(invalid);fail("invalid PDF must reject")}catch(_:java.io.IOException){}finally{invalid.delete()}
        }finally{source.delete();root.deleteRecursively()}
    }
    @Test fun actualNonzeroCropAndFourRotationsProducePortablePdfKitCoordinates()=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val root=File(context.cacheDir,"PdfCoordinates-QA-${UUID.randomUUID()}")
        val repo=PdfRepository(context,root)
        val source=File(context.cacheDir,"geometry-${UUID.randomUUID()}.pdf")
        try {
            com.tom_roush.pdfbox.pdmodel.PDDocument().use { pdf ->
                for(rotation in listOf(0,90,180,270)){
                    val page=com.tom_roush.pdfbox.pdmodel.PDPage(com.tom_roush.pdfbox.pdmodel.common.PDRectangle(400f,500f))
                    page.cropBox=com.tom_roush.pdfbox.pdmodel.common.PDRectangle(37f,53f,200f,300f);page.rotation=rotation;pdf.addPage(page)
                    com.tom_roush.pdfbox.pdmodel.PDPageContentStream(pdf,page).use{stream->stream.beginText();stream.setFont(com.tom_roush.pdfbox.pdmodel.font.PDType1Font.HELVETICA,12f);stream.newLineAtOffset(77f,153f);stream.showText("GEO");stream.endText()}
                }
                pdf.save(source)
            }
            val document=repo.importFile(source)
            assertEquals(4,document.pageCount)
            for(page in repo.readPages(document)) {
                val at=page.text.indexOf("GEO");assertTrue(at>=0)
                val selection=repo.select(document,page.page,at,at+3)
                assertTrue(selection.bounds.isNotEmpty())
                val annotation=repo.prepareAnnotation(document,selection,"真实旋转与非零crop验收")
                assertTrue("central preparation must not write legacy sidecars",File(root,"PdfAnnotations").listFiles().orEmpty().isEmpty())
                val portable=repo.portableMarks(document,annotation)
                val projected=repo.projectPortableAnnotations(document,portable).single()
                assertEquals(annotation.id,projected.id);assertEquals(annotation.selection.text,projected.selection.text);assertEquals(annotation.note,projected.note);assertEquals(annotation.createdAt,projected.createdAt)
                assertEquals(selection.bounds.size,projected.selection.bounds.size)
                selection.bounds.zip(projected.selection.bounds).forEach{(a,b)->assertEquals(a.page,b.page);assertEquals(a.left,b.left,.002f);assertEquals(a.top,b.top,.002f);assertEquals(a.right,b.right,.002f);assertEquals(a.bottom,b.bottom,.002f)}
                val mac=JSONObject(portable.first().toString()).apply{remove("extractor");remove("coordinateSystem");remove("groupID")}
                val macProjected=repo.projectPortableAnnotations(document,listOf(mac)).single()
                assertEquals(mac.getString("id"),macProjected.id);assertEquals("portable-pdf-user-space-v1",macProjected.selection.extractor)
                val separateBlank=listOf(JSONObject(mac.toString()).put("groupID"," "),JSONObject(mac.toString()).put("id",mac.getString("id")+"-independent").put("groupID"," ").put("text","Independent restored annotation"))
                assertEquals(separateBlank.map{it.getString("id")},repo.projectPortableAnnotations(document,separateBlank).map{it.id})
                assertTrue(separateBlank.all{it.getString("groupID")==" "}) // projection never rewrites preserved records
                assertTrue(repo.projectPortableAnnotations(document,listOf(JSONObject(mac.toString()).put("pdfSHA","f".repeat(64)))).isEmpty())
                suspend fun rejects(mark:JSONObject){try{repo.projectPortableAnnotations(document,listOf(mark));fail("invalid matching-source geometry must reject")}catch(_:IllegalArgumentException){}}
                rejects(JSONObject(mac.toString()).put("page",1.5));rejects(JSONObject(mac.toString()).put("page",0));rejects(JSONObject(mac.toString()).put("rect","{{0, 0}, {2, 3}}"));rejects(JSONObject(mac.toString()).put("rect","{{77, 153}, {NaN, 3}}"));rejects(JSONObject(mac.toString()).put("rect","{{77, 153}, {-2, 3}}"));rejects(JSONObject(mac.toString()).put("coordinateSystem","unverified-coordinates"))
                try{repo.projectPortableAnnotations(document,listOf(mac,JSONObject(mac.toString())));fail("duplicate central ids must reject")}catch(_:IllegalArgumentException){}
                assertTrue(File(root,"PdfAnnotations").listFiles().orEmpty().isEmpty())
                assertEquals(selection.bounds.size,portable.size)
                for(mark in portable){assertEquals(document.sha256,mark.getString("pdfSHA"));assertEquals(page.page,mark.getInt("page"));assertEquals(annotation.id,mark.getString("groupID"));assertEquals("pdf-user-space-unrotated-v1",mark.getString("coordinateSystem"))}
                val numbers=Regex("-?[0-9]+(?:\\.[0-9]+)?").findAll(portable.first().getString("rect")).map{it.value.toFloat()}.toList()
                assertEquals(77f,numbers[0],0.02f);assertEquals(153f,numbers[1],0.02f);assertTrue(numbers[2]>0f);assertTrue(numbers[3]>0f)
            }
        } finally {source.delete();root.deleteRecursively()}
    }

    @Test fun pagesWithoutTextNeverBecomeHeaderOnlyModelEvidence()=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val root=File(context.cacheDir,"PdfBlank-QA-${UUID.randomUUID()}");val repo=PdfRepository(context,root);val source=File(context.cacheDir,"blank-${UUID.randomUUID()}.pdf")
        try{
            com.tom_roush.pdfbox.pdmodel.PDDocument().use{pdf->pdf.addPage(com.tom_roush.pdfbox.pdmodel.PDPage());pdf.save(source)}
            val doc=repo.importFile(source);assertTrue(repo.readPages(doc).single().text.isBlank())
            try{repo.evidence(doc);fail("physical-page headers are not scientific evidence")}catch(e:IllegalArgumentException){assertTrue(e.message.orEmpty().contains("没有可提取"))}
        }finally{source.delete();root.deleteRecursively()}
    }

    @Test fun actualPdfOutlineUsesNamedAndLocalDestinationsWithNestedPhysicalRanges()=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val root=File(context.cacheDir,"PdfOutline-QA-${UUID.randomUUID()}");val repo=PdfRepository(context,root)
        val source=File(context.cacheDir,"outline-${UUID.randomUUID()}.pdf")
        try{
            com.tom_roush.pdfbox.pdmodel.PDDocument().use{pdf->
                repeat(4){pdf.addPage(com.tom_roush.pdfbox.pdmodel.PDPage())}
                fun destination(page:Int)=com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.destination.PDPageFitDestination().apply{this.page=pdf.getPage(page-1)}
                fun bookmark(title:String,page:Int)=com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem().apply{this.title=title;this.destination=destination(page)}
                val outline=com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.outline.PDDocumentOutline();pdf.documentCatalog.documentOutline=outline
                val intro=bookmark("1. Introduction",1);intro.addLast(bookmark("1.1 Background",2));outline.addLast(intro)
                val names=com.tom_roush.pdfbox.pdmodel.PDDestinationNameTreeNode().apply{this.names=mapOf("results" to destination(3))}
                pdf.documentCatalog.names=com.tom_roush.pdfbox.pdmodel.PDDocumentNameDictionary(pdf.documentCatalog).apply{dests=names}
                val results=com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem().apply{title="2. Results";destination=com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.destination.PDNamedDestination("results")};outline.addLast(results)
                val reference=com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem().apply{title="References";action=com.tom_roush.pdfbox.pdmodel.interactive.action.PDActionGoTo().apply{this.destination=destination(4)}};outline.addLast(reference)
                pdf.save(source)
            }
            val original=source.readBytes();val document=repo.importFile(source)
            assertEquals(listOf(PdfChapter(0,"1. Introduction",1,2,0),PdfChapter(1,"1.1 Background",2,2,1),PdfChapter(2,"2. Results",3,3,0),PdfChapter(3,"References",4,4,0)),repo.outline(document))
            assertArrayEquals(original,source.readBytes());assertArrayEquals(original,File(document.localPath).readBytes())
            for(mode in listOf("missing-named","backward","none")){
                com.tom_roush.pdfbox.pdmodel.PDDocument().use{pdf->
                    repeat(3){pdf.addPage(com.tom_roush.pdfbox.pdmodel.PDPage())}
                    if(mode!="none"){
                        val outline=com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.outline.PDDocumentOutline();pdf.documentCatalog.documentOutline=outline
                        outline.addLast(com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem().apply{title="First";destination=if(mode=="missing-named")com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.destination.PDNamedDestination("unresolved")else com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.destination.PDPageFitDestination().apply{page=pdf.getPage(2)}})
                        if(mode=="backward")outline.addLast(com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem().apply{title="Earlier physical page";destination=com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.destination.PDPageFitDestination().apply{page=pdf.getPage(0)}})
                    };pdf.save(source)
                }
                val variant=repo.importFile(source)
                if(mode=="none")assertTrue(repo.outline(variant).isEmpty())else try{repo.outline(variant);fail("unverified outline must not authorize a guessed chapter")}catch(e:IllegalArgumentException){assertTrue(e.message.orEmpty().contains(if(mode=="missing-named")"目的页" else "顺序"))}
            }
        }finally{source.delete();root.deleteRecursively()}
    }

}
