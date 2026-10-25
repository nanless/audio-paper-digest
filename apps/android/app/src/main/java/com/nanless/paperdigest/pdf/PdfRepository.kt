package com.nanless.paperdigest.pdf

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.AtomicFile
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.text.PDFTextStripper
import com.tom_roush.pdfbox.text.TextPosition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** Android-private original PDFs and coordinate sidecars, never overwrites the picked document. */
class PdfRepository(context: Context, researchRoot: File = File(context.noBackupFilesDir.canonicalFile, "PaperDigest")) {
    private val app = context.applicationContext
    private val root = researchRoot.also { require(!java.nio.file.Files.isSymbolicLink(it.toPath())) { "研究根不能是链接" };check(it.isDirectory || it.mkdirs()) }.canonicalFile
    private fun privateFolder(name:String):File { val f=File(root,name);require(!java.nio.file.Files.isSymbolicLink(f.toPath())) { "PDF 资料目录不能是链接" };check(f.isDirectory || f.mkdirs());return f.canonicalFile }
    private val imports = privateFolder("Imports")
    private val annotations = privateFolder("PdfAnnotations")
    init { PDFBoxResourceLoader.init(app) }

    suspend fun importPdf(uri: Uri, password: String? = null): PdfDocumentRef = withContext(Dispatchers.IO) {
        require(uri.scheme == "content") { "请通过系统文件选择器选择 PDF" }
        val name = app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        } ?: "本地论文.pdf"
        app.contentResolver.openInputStream(uri)?.use { store(it, name, password) } ?: error("原始 PDF 无法读取")
    }
    suspend fun importFile(file: File, displayName: String = file.name, password: String? = null): PdfDocumentRef = withContext(Dispatchers.IO) {
        file.inputStream().use { store(it, displayName, password) }
    }
    private suspend fun store(input: InputStream, name: String, password: String?): PdfDocumentRef {
        val staging = File(imports, ".incoming-" + UUID.randomUUID())
        try {
            var count = 0L
            staging.outputStream().use { out ->
                val buffer = ByteArray(64 * 1024)
                while (true) { currentCoroutineContext().ensureActive();val n = input.read(buffer); if (n < 0) break; count += n; require(count <= MAX_PDF_BYTES) { "PDF 超过200 MiB，原文件未修改" }; out.write(buffer, 0, n) }
            }
            require(count > 0) { "PDF 文件为空" }
            val pageCount = load(staging, password ?: "").use { it.numberOfPages }
            require(pageCount > 0) { "PDF 没有页面" }
            currentCoroutineContext().ensureActive()
            val sha = digest(staging)
            val destination = File(imports, "$sha.pdf")
            if (destination.exists()) require(digest(destination) == sha) { "同名原文内容损坏，未覆盖" }
            else check(staging.renameTo(destination)) { "原文保存失败" }
            return PdfDocumentRef("local:$sha", destination.absolutePath, sha, pageCount, name.take(500))
        } finally { staging.delete() }
    }
    private fun checked(document: PdfDocumentRef): File {
        require(Regex("[a-f0-9]{64}").matches(document.sha256)) { "PDF 来源校验无效" }
        val path = File(document.localPath)
        require(path.canonicalFile.parentFile == imports.canonicalFile && path.name == document.sha256 + ".pdf" && path.isFile && path.absoluteFile == path.canonicalFile) { "PDF 不在本应用已存原件范围" }
        require(path.length() <= MAX_PDF_BYTES && digest(path) == document.sha256) { "原文实际字节已变化，未使用其他版本" }
        return path
    }
    suspend fun verify(document: PdfDocumentRef): File = withContext(Dispatchers.IO) { checked(document) }
    suspend fun readPages(document: PdfDocumentRef, from: Int = 1, to: Int = document.pageCount, password: String? = null): List<PdfPageText> = withContext(Dispatchers.IO) {
        require(from >= 1 && to >= from && to <= document.pageCount) { "原文物理页范围无效" }
        load(checked(document), password ?: "").use { pdf ->
            require(pdf.numberOfPages == document.pageCount) { "原文页数与封存记录不符" }
            var totalCharacters=0
            (from..to).map { page ->
                val box = pdf.getPage(page - 1).cropBox
                currentCoroutineContext().ensureActive()
                val nativePage=pdf.getPage(page-1)
                val geometry=PdfPageGeometry(box.lowerLeftX,box.lowerLeftY,box.width,box.height,((nativePage.rotation%360)+360)%360)
                val extractor = CoordinateStripper(page,geometry)
                extractor.getText(pdf)
                totalCharacters+=extractor.content.length
                require(totalCharacters<=MAX_TEXT_CHARACTERS) { "原文提取文字过多，请改用较小页段；未截断或请求模型" }
                val rotation = geometry.rotation % 180
                PdfPageText(page, extractor.content.toString(), if (rotation == 90) box.height else box.width, if (rotation == 90) box.width else box.height, extractor.spans.toList())
            }
        }
    }
    /** Reads actual PDF outline destinations only. Never derives chapter authority from guide headings. */
    suspend fun outline(document:PdfDocumentRef):List<PdfChapter> = withContext(Dispatchers.IO) {
        load(checked(document)).use { pdf ->
            require(pdf.numberOfPages==document.pageCount) { "PDF 实际页数与原件记录不符" }
            val outline=pdf.documentCatalog.documentOutline ?: return@withContext emptyList()
            val pageNumbers=java.util.IdentityHashMap<com.tom_roush.pdfbox.cos.COSDictionary,Int>()
            for((index,page) in pdf.pages.withIndex()){currentCoroutineContext().ensureActive();pageNumbers[page.cosObject]=index+1}
            val visited=java.util.Collections.newSetFromMap(java.util.IdentityHashMap<com.tom_roush.pdfbox.cos.COSDictionary,Boolean>())
            val rows=mutableListOf<Triple<String,Int,Int>>()
            var count=0
            suspend fun walk(first:com.tom_roush.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineItem?,depth:Int) {
                require(depth<=16) { "PDF 目录层级超过可核验范围，未猜测章节" }
                var item=first
                while(item!=null){
                    currentCoroutineContext().ensureActive();val node=item
                    require(++count<=1000 && visited.add(node.cosObject)) { "PDF 目录循环或过大，未授予错误章节范围" }
                    val hasLocalDestination=node.destination!=null || node.action is com.tom_roush.pdfbox.pdmodel.interactive.action.PDActionGoTo
                    if(hasLocalDestination){
                        val destination=node.findDestinationPage(pdf) ?: throw IllegalArgumentException("PDF 目录目的页未能解析，未猜测章节")
                        val physicalPage=pageNumbers[destination.cosObject]
                        require(physicalPage!=null) { "PDF 目录指向原件之外，未采用外部页码" }
                        val title=node.title?.trim().orEmpty();require(title.isNotEmpty()&&title.length<=2000) { "PDF 目录缺少可核验标题" }
                        rows+=Triple(title,physicalPage,depth)
                    }
                    if(node.firstChild!=null)walk(node.firstChild,depth+1)
                    item=node.nextSibling
                }
            }
            walk(outline.firstChild,0)
            require(rows.zipWithNext().all { (a,b)->b.second>=a.second }) { "PDF 目录页次不是顺序排列，不能安全推导连续章节范围；请使用实际页段" }
            rows.mapIndexed { index,row ->
                val next=rows.drop(index+1).firstOrNull { it.third<=row.third }
                PdfChapter(index,row.first,row.second,((next?.second?.minus(1)) ?: document.pageCount).coerceAtLeast(row.second),row.third)
            }
        }
    }
    suspend fun evidence(document: PdfDocumentRef, from: Int = 1, to: Int = document.pageCount, maxCharacters: Int = 240000): PdfEvidence {
        require(maxCharacters in 1..1000000)
        val pages = readPages(document, from, to)
        require(pages.any { it.text.isNotBlank() }) { "所选页面没有可提取的原文文字，未将页码或图像冒充模型证据" }
        val text = pages.joinToString("\n\n") { "[原文物理页 ${it.page}]\n${it.text}" }
        require(text.length <= maxCharacters) { "所选原文超过模型上下文上限，请缩小页码范围；未静默截断" }
        return PdfEvidence(document.sha256, if (from == 1 && to == document.pageCount) "pdf-document" else "pdf-range", pages.map { it.page }, text, pages.filter { it.text.isBlank() }.map { it.page })
    }
    suspend fun search(document: PdfDocumentRef, query: String): List<PdfSearchMatch> = PdfTextSemantics.search(readPages(document), query)
    suspend fun select(document: PdfDocumentRef, page: Int, start: Int, end: Int): PdfSelection = PdfTextSemantics.selection(document.sha256, readPages(document, page, page).single(), start, end)
    /** Validates a prospective central annotation without writing a sidecar or personal state. */
    suspend fun prepareAnnotation(document: PdfDocumentRef, selection: PdfSelection, note: String): PdfAnnotation = withContext(Dispatchers.IO) {
        checked(document)
        require(selection.coordinateSystem=="rotated-crop-top-left-points-v1" && selection.documentSHA256 == document.sha256 && selection.pages.isNotEmpty() && selection.pages.distinct().size==selection.pages.size && selection.pages.all { it in 1..document.pageCount } && selection.text.isNotBlank()) { "批注不属于此版本原文" }
        require(note.length <= 20000 && selection.text.length <= 100000 && selection.bounds.isNotEmpty()) { "批注过长或没有可核对的页面坐标" }
        require(selection.extractor in listOf("android-pdfbox-physical-pages-v1","android-jetpack-pdf-selection-v1")) { "批注提取来源未声明" }
        for (b in selection.bounds) require(b.page in selection.pages && listOf(b.left,b.top,b.right,b.bottom).all { it.isFinite() } && b.left >= 0 && b.top >= 0 && b.right > b.left && b.bottom > b.top) { "批注页面坐标无效" }
        val annotation = PdfAnnotation(UUID.randomUUID().toString(), selection, note, Instant.now().toString())
        portableMarks(document,annotation) // checks actual crop, rotation and physical page before the single central commit
        annotation
    }
    /** Legacy sidecar I/O remains readable for old backups; product saving uses prepareAnnotation + central batch. */
    suspend fun saveAnnotation(document: PdfDocumentRef, selection: PdfSelection, note: String): PdfAnnotation = withContext(Dispatchers.IO) {
        val annotation=prepareAnnotation(document,selection,note)
        synchronized(annotationLock) {
            val all = loadAnnotationsNow(document).toMutableList().apply { add(annotation) }
            writeAnnotationsNow(document, all)
        }
        annotation
    }
    /** Read-only projection of the authoritative portable records, including restored Mac PDFKit marks. */
    suspend fun projectPortableAnnotations(document:PdfDocumentRef, marks:List<JSONObject>):List<PdfAnnotation> = withContext(Dispatchers.IO) {
        val current=marks.filter { it.optString("pdfSHA")==document.sha256 }
        require(current.size<=100000) { "标注数量超过可核验上限" }
        require(current.map{it.getString("id")}.distinct().size==current.size) { "中央标注身份重复，未显示不明确的覆盖层" }
        load(checked(document)).use { pdf ->
            require(pdf.numberOfPages==document.pageCount) { "原文页数与封存记录不符" }
            val projected=current.map { mark ->
                val rawPage=mark.get("page");require(rawPage is Number && rawPage.toDouble().isFinite() && rawPage.toDouble()==rawPage.toInt().toDouble()) { "中央标注物理页无效" }
                val page=rawPage.toInt();require(page in 1..document.pageCount) { "中央标注物理页超出原文" }
                val id=mark.getString("id");val group=mark.optString("groupID").ifBlank{id};require(id.isNotEmpty() && group.isNotEmpty() && id.length<=256 && group.length<=256) { "中央标注身份无效" }
                require(!mark.has("coordinateSystem") || mark.getString("coordinateSystem")=="pdf-user-space-unrotated-v1") { "中央标注坐标系统不兼容，原记录保留" }
                val rect=parsePortableRect(mark.getString("rect"))
                val p=pdf.getPage(page-1);val crop=p.cropBox
                require(rect.x>=crop.lowerLeftX-.01f && rect.y>=crop.lowerLeftY-.01f && rect.x+rect.width<=crop.upperRightX+.01f && rect.y+rect.height<=crop.upperRightY+.01f) { "中央标注超出真实原文裁切范围" }
                val geometry=PdfPageGeometry(crop.lowerLeftX,crop.lowerLeftY,crop.width,crop.height,((p.rotation%360)+360)%360)
                val bounds=PdfCoordinates.toDisplaySpace(page,rect,geometry)
                val text=mark.optString("text");val note=mark.optString("comment",mark.optString("note"));val createdAt=mark.getString("createdAt")
                require(text.length<=100000 && note.length<=20000) { "中央标注内容过长" };Instant.parse(createdAt)
                val extractor=mark.optString("extractor").ifEmpty{"portable-pdf-user-space-v1"}
                PdfAnnotation(group,PdfSelection(document.sha256,text,listOf(page),listOf(bounds),extractor=extractor),note,createdAt)
            }
            projected.groupBy{it.id}.map { (_,parts) ->
                val first=parts.first()
                require(parts.all{it.selection.text==first.selection.text && it.selection.extractor==first.selection.extractor && it.note==first.note && it.createdAt==first.createdAt}) { "中央同组标注内容不一致，未合并不同记录" }
                first.copy(selection=first.selection.copy(pages=parts.flatMap{it.selection.pages}.distinct(),bounds=parts.flatMap{it.selection.bounds}))
            }
        }
    }
    private fun parsePortableRect(value:String):PdfUserRect {
        val number="([+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?)"
        val match=Regex("^\\s*\\{\\{\\s*"+number+"\\s*,\\s*"+number+"\\s*\\},\\s*\\{\\s*"+number+"\\s*,\\s*"+number+"\\s*\\}\\}\\s*$").matchEntire(value)
            ?: throw IllegalArgumentException("中央标注矩形格式无效")
        val numbers=(1..4).map { match.groupValues[it].toFloat() }
        require(numbers.all{it.isFinite()} && numbers[2]>0 && numbers[3]>0) { "中央标注矩形无效" }
        return PdfUserRect(numbers[0],numbers[1],numbers[2],numbers[3])
    }
    /** One PDFKit-compatible entry per actual rectangle; preserves the Android group sidecar. */
    suspend fun portableMarks(document: PdfDocumentRef, annotation: PdfAnnotation): List<JSONObject> = withContext(Dispatchers.IO) {
        require(annotation.selection.documentSHA256==document.sha256 && annotation.selection.coordinateSystem=="rotated-crop-top-left-points-v1")
        load(checked(document)).use { pdf ->
            annotation.selection.bounds.mapIndexed { index,b ->
                require(b.page in 1..document.pageCount)
                val p=pdf.getPage(b.page-1);val crop=p.cropBox
                val geometry=PdfPageGeometry(crop.lowerLeftX,crop.lowerLeftY,crop.width,crop.height,((p.rotation%360)+360)%360)
                val rect=PdfCoordinates.toUserSpace(b,geometry)
                require(rect.x>=crop.lowerLeftX-0.01f && rect.y>=crop.lowerLeftY-0.01f && rect.x+rect.width<=crop.upperRightX+0.01f && rect.y+rect.height<=crop.upperRightY+0.01f) { "标注超出原文裁切范围，未导出错误坐标" }
                JSONObject().put("id",annotation.id+"-"+index).put("groupID",annotation.id).put("text",annotation.selection.text).put("comment",annotation.note).put("page",b.page).put("rect",String.format(java.util.Locale.ROOT,"{{%.6f, %.6f}, {%.6f, %.6f}}",rect.x,rect.y,rect.width,rect.height)).put("pdfSHA",document.sha256).put("createdAt",annotation.createdAt).put("coordinateSystem","pdf-user-space-unrotated-v1").put("extractor",annotation.selection.extractor)
            }
        }
    }
    suspend fun removeAnnotation(document: PdfDocumentRef, id: String): List<PdfAnnotation> = withContext(Dispatchers.IO) {
        checked(document)
        synchronized(annotationLock) {
            val current=loadAnnotationsNow(document)
            require(current.count { it.id==id } == 1) { "原标注不存在或身份不唯一，未删除其他内容" }
            current.filterNot { it.id==id }.also { writeAnnotationsNow(document,it) }
        }
    }
    suspend fun updateAnnotation(document: PdfDocumentRef, id: String, note: String): List<PdfAnnotation> = withContext(Dispatchers.IO) {
        checked(document);require(note.length<=20000) { "批注过长" }
        synchronized(annotationLock) {
            val current=loadAnnotationsNow(document)
            require(current.count { it.id==id } == 1) { "原标注不存在或身份不唯一，未修改其他内容" }
            current.map { if(it.id==id)it.copy(note=note) else it }.also { writeAnnotationsNow(document,it) }
        }
    }
    private fun writeAnnotationsNow(document:PdfDocumentRef,all:List<PdfAnnotation>) {
        val array=JSONArray()
        for(a in all)array.put(JSONObject().put("id",a.id).put("documentSHA256",a.selection.documentSHA256).put("text",a.selection.text).put("coordinateSystem",a.selection.coordinateSystem).put("extractor",a.selection.extractor).put("pages",JSONArray(a.selection.pages)).put("bounds",JSONArray(a.selection.bounds.map { b -> JSONObject().put("page",b.page).put("left",b.left).put("top",b.top).put("right",b.right).put("bottom",b.bottom) })).put("note",a.note).put("createdAt",a.createdAt))
        val file=AtomicFile(File(annotations,document.sha256+".json"));val out=file.startWrite()
        try{out.write(JSONObject().put("contract","paperdigest-pdf-annotations-v1").put("sha256",document.sha256).put("annotations",array).toString().toByteArray());file.finishWrite(out)}catch(e:Throwable){file.failWrite(out);throw e}
    }
    suspend fun loadAnnotations(document: PdfDocumentRef): List<PdfAnnotation> = withContext(Dispatchers.IO) { checked(document);synchronized(annotationLock) { loadAnnotationsNow(document) } }
    private fun loadAnnotationsNow(document: PdfDocumentRef): List<PdfAnnotation> {
        val file=File(annotations,document.sha256+".json");require(!java.nio.file.Files.isSymbolicLink(file.toPath())) { "批注文件不能是链接" };if(!file.exists())return emptyList()
        require(file.length() <= 16*1024*1024) { "批注文件过大，未覆盖" }
        val root=JSONObject(file.readText());require(root.getString("contract")=="paperdigest-pdf-annotations-v1" && root.getString("sha256")==document.sha256)
        val array=root.getJSONArray("annotations")
        val result=(0 until array.length()).map { i -> val a=array.getJSONObject(i);val pages=a.getJSONArray("pages");val bounds=a.getJSONArray("bounds");require(a.optString("coordinateSystem")=="rotated-crop-top-left-points-v1") { "批注坐标系统未声明，原文件保留" };PdfAnnotation(a.getString("id"),PdfSelection(a.getString("documentSHA256"),a.getString("text"),(0 until pages.length()).map{pages.getInt(it)},(0 until bounds.length()).map{n->val b=bounds.getJSONObject(n);PdfSelectionBounds(b.getInt("page"),b.getDouble("left").toFloat(),b.getDouble("top").toFloat(),b.getDouble("right").toFloat(),b.getDouble("bottom").toFloat())},extractor=a.getString("extractor")),a.getString("note"),a.getString("createdAt")) }
        require(result.map{it.id}.distinct().size==result.size) { "批注身份重复，原文件保留" }
        for(a in result){
            require(a.selection.documentSHA256==document.sha256 && a.selection.text.isNotBlank() && a.selection.text.length<=100000 && a.selection.extractor in listOf("android-pdfbox-physical-pages-v1","android-jetpack-pdf-selection-v1") && a.note.length<=20000 && a.selection.pages.isNotEmpty() && a.selection.pages.distinct().size==a.selection.pages.size && a.selection.pages.all{it in 1..document.pageCount}) { "批注来源或页码无效，原文件保留" }
            UUID.fromString(a.id);Instant.parse(a.createdAt)
            for(b in a.selection.bounds)require(b.page in a.selection.pages && listOf(b.left,b.top,b.right,b.bottom).all{it.isFinite()} && b.left>=0 && b.top>=0 && b.right>=b.left && b.bottom>=b.top) { "批注坐标无效，原文件保留" }
        }
        return result
    }
    private fun load(file:File,password:String=""):PDDocument=PDDocument.load(file,password,MemoryUsageSetting.setupMixed(32L*1024*1024,512L*1024*1024))
    companion object { const val MAX_TEXT_CHARACTERS=1000000;const val MAX_PDF_BYTES=200L*1024*1024;private val annotationLock=Any();fun digest(file:File):String { val md=MessageDigest.getInstance("SHA-256");file.inputStream().use{input->val buffer=ByteArray(65536);while(true){val n=input.read(buffer);if(n<0)break;md.update(buffer,0,n)}};return md.digest().joinToString(""){"%02x".format(it)} } }
}

private class CoordinateStripper(private val physicalPage:Int,private val geometry:PdfPageGeometry):PDFTextStripper() {
    val content=StringBuilder();val spans=mutableListOf<PdfTextSpan>()
    init { startPage=physicalPage;endPage=physicalPage;sortByPosition=true }
    override fun writeString(text:String,positions:MutableList<TextPosition>) {
        require(content.length.toLong()+text.length<=PdfRepository.MAX_TEXT_CHARACTERS) { "本页文字超过安全上限，原件保留" }
        val base=content.length;content.append(text);var cursor=0
        for(p in positions){val glyph=p.unicode ?: continue;val at=text.indexOf(glyph,cursor);if(at<0)continue;cursor=at+glyph.length;val x=p.textMatrix.translateX+geometry.cropLeft;val y=p.textMatrix.translateY+geometry.cropBottom;val w=p.widthDirAdj;val h=p.heightDir
            val rect=when(p.dir.toInt()){90->PdfUserRect(x-h,y,h,w);180->PdfUserRect(x-w,y-h,w,h);270->PdfUserRect(x,y-w,h,w);else->PdfUserRect(x,y,w,h)}
            spans.add(PdfTextSpan(base+at,base+cursor,PdfCoordinates.toDisplaySpace(physicalPage,rect,geometry))) }
    }
    override fun writeWordSeparator(){content.append(' ')}
    override fun writeLineSeparator(){content.append('\n')}
}
