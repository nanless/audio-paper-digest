package com.nanless.paperdigest.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.IdentityHashMap
import java.util.concurrent.ConcurrentHashMap

/** Published citation originals only: never rebuild bibliography text from catalog fields. */
class PublishedCitationRepository(researchDirectory:File,private val read:suspend(String,Int)->ByteArray) {
    enum class Format(val route:String,val filename:String,val mime:String) {
        BIBTEX("bibtex","citation.bib","application/x-bibtex"),
        RIS("ris","citation.ris","application/x-research-info-systems"),
        JSON("citation-json","citation.json","application/json");
        companion object {fun fromRoute(route:String)=entries.singleOrNull{it.route==route}?:throw AppFailure("citation","引用格式不受支持")}
    }
    class PublishedPage internal constructor(val html:String,val sourceURL:String)
    private data class Fetched(val paper:Paper,val raw:ByteArray,val hash:String)
    class Original internal constructor(private val raw:ByteArray,private val record:JSONObject) {
        val bytes:ByteArray get()=raw.copyOf()
        val sha256:String get()=record.getString("sha256")
        val sourceURL:String get()=record.getString("sourceURL")
        val filename:String get()=record.getString("filename")
        val mime:String get()=record.getString("mime")
        fun metadata():JSONObject=record.copy()
    }
    private val root=makeRoot(researchDirectory)
    private val identity=directoryIdentity(root)
    private val mutex=locks.computeIfAbsent(root.absolutePath+"|"+identity){Mutex()}
    private val fetched=IdentityHashMap<PublishedPage,Fetched>()

    /** This opaque handle is issued only by this instance's safe website reader. */
    suspend fun fetchPage(paper:Paper):PublishedPage=withContext(Dispatchers.IO) {
        val frozen=Paper.fromJson(paper.json());val url=pageURL(frozen.blogURL)
        currentCoroutineContext().ensureActive();checkRoot()
        val raw=read(url,MAX_PAGE);require(raw.size in 1..MAX_PAGE){"已发布页面为空或超过读取限制"}
        val html=PublishedUtf8.decode(raw);currentCoroutineContext().ensureActive();checkRoot()
        PublishedPage(html,url).also{handle->synchronized(fetched){fetched[handle]=Fetched(frozen,raw.copyOf(),sha256(raw))}}
    }
    fun releasePage(page:PublishedPage){synchronized(fetched){fetched.remove(page)}}

    /** Before hydration, replay the actual parser against the same raw page. A copied JSON cannot mint this handle. */
    suspend fun bindPage(paper:Paper,article:Article,page:PublishedPage,requireCurrent:()->Unit={}):Article=withContext(Dispatchers.IO) {
        val witness=synchronized(fetched){fetched.remove(page)}?:throw AppFailure("citation","已发布页面读取凭证已失效，未把另一页面绑定为引用来源")
        mutex.withLock {
            currentCoroutineContext().ensureActive();requireCurrent();checkRoot()
            require(pageURL(paper.blogURL)==page.sourceURL&&canonical(paperIdentity(paper))==canonical(paperIdentity(witness.paper))){"页面属于另一论文或原文版本"}
            require(sha256(witness.raw)==witness.hash){"实际发布页面字节已变化"}
            val replay=replayPage(paper,article,witness.raw)
            require(article.html==replay.html&&article.markdown==replay.markdown){"引用页面只能绑定尚未hydrate且逐字一致的真实导读正文"}
            val proof=JSONObject().put("contract",PAGE_CONTRACT).put("paper",paperIdentity(paper)).put("pageURL",page.sourceURL)
                .put("pageSHA256",witness.hash).put("pageBytes",witness.raw.size).put("articleRevisionSHA256",replay.revisionSHA256)
            requireCurrent();currentCoroutineContext().ensureActive();storeImmutable(checked("pages",witness.hash+".html"),witness.raw)
            requireCurrent();currentCoroutineContext().ensureActive()
            article.copy(original=article.json().put(PAGE_FIELD,proof))
        }
    }

    /** Metadata/Context discovery is also exact per-file, never citation.json's guessed siblings. */
    suspend fun declaredFiles(paper:Paper,article:Article):Map<String,String> =withContext(Dispatchers.IO){mutex.withLock{
        val raw=boundPage(paper,article);val html=PublishedUtf8.decode(raw)
        (Format.entries.map{it.filename}+"rethink-context.json").mapNotNull{name->runCatching{selectLink(html,paper.blogURL,name)}.getOrNull()?.let{name to it}}.toMap()
    }}

    suspend fun original(paper:Paper,article:Article,format:Format,offline:Boolean=false,verifyRemote:Boolean=false,requireCurrent:()->Unit={}):Original=withContext(Dispatchers.IO) {
        val frozen=Paper.fromJson(paper.json())
        requireEligible(frozen,article);requireCurrent();currentCoroutineContext().ensureActive()
        mutex.withLock {
            checkRoot();requireCurrent();currentCoroutineContext().ensureActive()
            val page=boundPage(frozen,article)
            val address=selectLink(PublishedUtf8.decode(page),frozen.blogURL,format.filename)
                ?:throw AppFailure("citationUnavailable","这个已发布版本没有此格式的真实引用原件；未现场生成替代引用。")
            val binding=binding(frozen,article,sha256(page))
            val key=sha256(canonical(JSONObject().put("binding",binding).put("format",format.route).put("sourceURL",address)).toByteArray())
            val receipt=checked("receipts",key+".json")
            val old=if(receipt.exists())readOriginal(receipt,binding,address,format)else null
            if(old!=null&&(!verifyRemote||offline)){requireCurrent();currentCoroutineContext().ensureActive();checkRoot();return@withLock old}
            if(offline)throw AppFailure("citationUnavailable","离线没有这份阅读版本已核验的引用原件，请联网刷新并保存该版本。")
            requireCurrent();currentCoroutineContext().ensureActive()
            val raw=read(address,MAX_CITATION)
            require(raw.size in 1..MAX_CITATION){"引用原件为空或超过读取限制"}
            validateBytes(raw,frozen,format)
            currentCoroutineContext().ensureActive();requireCurrent();checkRoot()
            val hash=sha256(raw)
            if(old!=null){require(old.sha256==hash){"同一发布链接返回了不同引用字节；原文件保留，未把新文件冒充原已核版本。"};return@withLock old}
            val record=JSONObject().put("contract",ORIGINAL_CONTRACT).put("binding",binding).put("filename",format.filename).put("format",format.route).put("mime",format.mime)
                .put("sourceURL",address).put("bytes",raw.size).put("sha256",hash).put("validatedAt",now())
                .put("validationScope","same-site-direct-link;reading-page-owner-version-revision;single-format-content")
                .put("bundleHashVerified",false).put("publishedSHA256",JSONObject.NULL)
            storeImmutable(checked("raw",hash+"."+format.filename.substringAfterLast('.')),raw)
            requireCurrent();currentCoroutineContext().ensureActive();checkRoot()
            storeImmutable(receipt,canonical(record).toByteArray())
            requireCurrent();currentCoroutineContext().ensureActive()
            readOriginal(receipt,binding,address,format)
        }
    }

    private fun boundPage(paper:Paper,article:Article):ByteArray {
        ReadingSourceBinding.requireArticle(paper,article);ReadingSourceBinding.requireCitation(paper,article.citation);checkRoot()
        val proof=article.original?.optJSONObject(PAGE_FIELD)?.copy()?:throw AppFailure("citationUnavailable","这份旧导读没有封存真实引用下载页面；请显式刷新导读后再导出引用，其他研究资料仍可正常使用。")
        require(proof.optString("contract")==PAGE_CONTRACT&&canonical(proof.getJSONObject("paper"))==canonical(paperIdentity(paper))&&proof.getString("pageURL")==pageURL(paper.blogURL)&&proof.getString("articleRevisionSHA256")==article.revisionSHA256){"引用页面与实际阅读论文或修订不一致"}
        val hash=proof.getString("pageSHA256");require(validSHA(hash))
        val raw=JsonFiles.read(checked("pages",hash+".html"),MAX_PAGE.toLong())
        require(raw.size.toLong()==strictCount(proof,"pageBytes")&&sha256(raw)==hash){"原引用下载页面的保存字节已变化"}
        replayPage(paper,article,raw);checkRoot();return raw
    }
    private fun replayPage(paper:Paper,article:Article,raw:ByteArray):Article {
        val replay=CatalogRepository.extractArticle(PublishedUtf8.decode(raw),paper,article.catalogEpoch)
        ReadingSourceBinding.requireArticle(paper,article);ReadingSourceBinding.requireArticle(paper,replay)
        require(replay.revisionSHA256==article.revisionSHA256&&replay.plainText==article.plainText&&replay.markdown==article.markdown&&canonical(replay.citation)==canonical(article.citation)){"新的发布页面与实际阅读导读不是同一修订，未替换旧来源。"}
        if(paper.identityStatus=="verified") {
            val title=replay.citation.nullableString("title")?:replay.citation.nullableString("originalTitle")
            require(title!=null&&normalize(title)==normalize(paper.title)){"已发布页面的原题名与阅读论文不一致"}
        }
        return replay
    }
    private fun requireEligible(paper:Paper,article:Article) {
        require(paper.identityStatus=="verified"&&paper.sourceKind in listOf("arxiv","conference")&&!paper.id.startsWith("local:")){"此资料没有可核验的已发布引用原件；未猜写出版类型或论文编号。"}
        ReadingSourceBinding.requireArticle(paper,article);ReadingSourceBinding.requireCitation(paper,article.citation)
        pageURL(paper.blogURL)
        require(!paper.sourceURL.isNullOrBlank()){ "当前论文缺少可核验的原始来源地址，引用原件不可用" }
        for(address in listOfNotNull(paper.sourceURL,paper.pdfURL)) {
            val uri=URI(address);require(uri.scheme=="https"&&uri.host!=null&&uri.userInfo==null&&uri.port in listOf(-1,443)){"引用身份地址包含不安全协议或凭据"}
        }
        if(paper.sourceKind=="arxiv") {
            val version=paper.sourceVersion?:error("引用导出需要明确的当前 arXiv 原文版本")
            require(Regex("v[1-9][0-9]*$").containsMatchIn(version)&&paper.id=="arxiv:"+version.replace(Regex("v[1-9][0-9]*$"),"")){"引用论文编号与原文版本不一致"}
            val source=URI(paper.sourceURL!!);val pdf=URI(paper.pdfURL?:error("引用缺少当前原始PDF地址"))
            require(listOf(source,pdf).all{it.scheme=="https"&&it.host in listOf("arxiv.org","export.arxiv.org")&&it.port in listOf(-1,443)&&it.userInfo==null&&it.query==null&&it.fragment==null}&&source.path=="/abs/$version"&&pdf.path.removeSuffix(".pdf")=="/pdf/$version"){"引用来源地址没有固定到当前 arXiv 版本"}
        }else require(paper.id.startsWith("conference:")){"会议引用缺少明确的会议论文身份"}
    }
    private fun readOriginal(receipt:File,binding:JSONObject,address:String,format:Format):Original {
        val record=StrictJson.parse(PublishedUtf8.decode(JsonFiles.read(receipt,65536)))
        require(record.getString("contract")==ORIGINAL_CONTRACT&&canonical(record.getJSONObject("binding"))==canonical(binding)&&record.getString("sourceURL")==address&&record.getString("format")==format.route&&record.getString("filename")==format.filename&&record.getString("mime")==format.mime&&record.get("bundleHashVerified")==false&&record.has("publishedSHA256")&&record.isNull("publishedSHA256")&&record.getString("validationScope")=="same-site-direct-link;reading-page-owner-version-revision;single-format-content"){"引用原件保存记录身份不符"}
        val date=record.get("validatedAt");require(date is String&&date.endsWith("Z"));java.time.Instant.parse(date)
        val hash=record.getString("sha256");require(validSHA(hash));val bytes=JsonFiles.read(checked("raw",hash+"."+format.filename.substringAfterLast('.')),MAX_CITATION.toLong())
        require(sha256(bytes)==hash&&bytes.size.toLong()==strictCount(record,"bytes")){"已保存引用原件已变化，未重新生成或静默换用其他文件"}
        // A cold read must replay both page provenance and individual format validation.
        val p=Paper.fromJson(binding.getJSONObject("paper"));validateBytes(bytes,p,format);checkRoot()
        return Original(bytes,record)
    }
    private fun binding(paper:Paper,article:Article,pageSHA:String)=JSONObject().put("paper",paperIdentity(paper)).put("articleRevisionSHA256",article.revisionSHA256).put("pageSHA256",pageSHA).put("pageURL",pageURL(paper.blogURL))
    private fun paperIdentity(paper:Paper)=JSONObject().put("id",paper.id).put("title",paper.title).put("blogURL",pageURL(paper.blogURL)).put("sourceKind",paper.sourceKind).put("identityStatus",paper.identityStatus).put("sourceURL",paper.sourceURL?:JSONObject.NULL).put("pdfURL",paper.pdfURL?:JSONObject.NULL).put("sourceVersion",paper.sourceVersion?:JSONObject.NULL)
    private fun checkRoot(){require(root.absoluteFile==root.canonicalFile&&!Files.isSymbolicLink(root.toPath())&&directoryIdentity(root)==identity){"引用研究目录身份已变化，未在新目录认领旧保存记录"}}
    private fun checked(folder:String,name:String):File {
        checkRoot();require(folder in listOf("pages","raw","receipts")&&name.matches(Regex("[a-f0-9]{64}\\.(?:html|json|bib|ris)")))
        val parent=File(root,folder);require(!Files.isSymbolicLink(parent.toPath()));check(parent.isDirectory||parent.mkdir());require(parent.absoluteFile==parent.canonicalFile)
        val file=File(parent,name);require(!Files.isSymbolicLink(file.toPath())&&file.absoluteFile==file.canonicalFile);return file
    }
    private fun storeImmutable(file:File,raw:ByteArray){checkRoot();if(file.exists())require(JsonFiles.read(file,maxOf(MAX_PAGE,MAX_CITATION).toLong()).contentEquals(raw)){"已封存引用材料发生冲突，旧字节保留"}else JsonFiles.write(file,raw);checkRoot()}
    companion object {
        const val PAGE_FIELD="publishedCitationPage"
        private const val PAGE_CONTRACT="published-citation-page-v1"
        private const val ORIGINAL_CONTRACT="published-citation-original-v1"
        private const val MAX_PAGE=8*1024*1024
        private const val MAX_CITATION=1024*1024
        private val locks=ConcurrentHashMap<String,Mutex>()
        private fun makeRoot(input:File):File {require(!Files.isSymbolicLink(input.toPath())&&input.absoluteFile==input.canonicalFile);var p:File?=input;while(p!=null){require(!Files.isSymbolicLink(p.toPath()));p=p.parentFile};check(input.isDirectory||input.mkdirs());return input.canonicalFile}
        private fun directoryIdentity(file:File):String {val a=Files.readAttributes(file.toPath(),BasicFileAttributes::class.java,LinkOption.NOFOLLOW_LINKS);require(a.isDirectory&&!a.isSymbolicLink);return (a.fileKey()?:throw AppFailure("citation","当前文件系统不能核验引用目录身份")).toString()+"|"+a.creationTime().toMillis()}
        private fun validSHA(value:String)=value.matches(Regex("[a-f0-9]{64}"))
        private fun strictCount(value:JSONObject,key:String):Long {val n=value.get(key);require(n is Number&&n.toDouble().isFinite()&&n.toDouble()==n.toLong().toDouble()&&n.toLong()>0);return n.toLong()}
        private fun normalize(value:String)=value.replace(Regex("\\s+")," ").trim()
        private fun pageURL(value:String):String=CatalogRepository.sameSite(value).also {require(URI(it).path.startsWith("/audio-paper-digest-blog/posts/")){"引用页面超出已发布论文目录"}}
        private fun selectLink(html:String,base:String,name:String):String? {
            require(name in listOf("citation.json","citation.bib","citation.ris","rethink-context.json"))
            val matches=Jsoup.parse(html,base).select("a[href]").mapNotNull{element->
                val raw=element.attr("href");val relative=runCatching{URI(raw)}.getOrNull()?:return@mapNotNull null
                if(relative.path?.substringAfterLast('/')!=name)return@mapNotNull null
                require(relative.path.split('/').none{it=="."||it==".."}){"引用下载路径包含不明确的父目录"}
                val url=CatalogRepository.sameSite(URI(base).resolve(relative).toASCIIString())
                require(URI(url).path.startsWith("/audio-paper-digest-blog/data/papers/")){"引用原件下载地址超出已发布文件目录"};url
            }.distinct()
            require(matches.size<=1){"此格式存在不同的引用下载地址，未猜选其中一份"};return matches.singleOrNull()
        }
        private fun validateBytes(raw:ByteArray,paper:Paper,format:Format) {
            require(raw.isNotEmpty()&&raw.size<=MAX_CITATION);val text=PublishedUtf8.decode(raw)
            require(text.isNotBlank()&&!Regex("(?i)<html(?:\\s|>)|<!doctype\\s+html").containsMatchIn(text)){"引用下载返回了空文件或错误网页"}
            when(format){
                Format.JSON->validateJson(text,paper)
                Format.BIBTEX->{val bib=Bib.parse(text);require(normalize(bibText(bib.second["title"]?:""))==normalize(paper.title)){"BibTeX题名与当前论文不符"};require(bibText(bib.second["url"]?:"")==paper.sourceURL){"BibTeX缺少可核对的当前来源网址"};if(paper.sourceKind=="arxiv"){require(bib.first=="misc"&&bibText(bib.second["eprint"]?:"")==paper.sourceVersion&&bibText(bib.second["archiveprefix"]?:"").equals("arXiv",true)){"BibTeX的论文身份或版本不符"}}else require(bib.first=="inproceedings"&&!bib.second.containsKey("eprint")){"会议引用类型不符，未把会议编号当作eprint"}}
                Format.RIS->{val fields=ris(text);require(normalize(fields["TI"]?.singleOrNull().orEmpty())==normalize(paper.title)){"RIS题名与当前论文不符"};require(fields["UR"]?.singleOrNull()==paper.sourceURL){"RIS来源网址与当前论文不符"};fields["L1"]?.singleOrNull()?.let{require(it==paper.pdfURL){"RIS的PDF来源与当前版本不符"}};if(paper.sourceKind=="arxiv")require(fields["TY"]?.singleOrNull()=="UNPB"&&fields["ID"]?.singleOrNull()==paper.sourceVersion){"RIS原文身份或版本不符"}else require(fields["TY"]?.singleOrNull()=="CONF"&&fields["ID"]?.singleOrNull()==paper.id){"RIS会议身份不符"}}
            }
        }
        private fun validateJson(text:String,paper:Paper) {
            val json=StrictJson.parse(text)
            CatalogRepository.validatedSidecar(json,paper,false)
            val schema=json.get("schemaVersion");require(schema is Number&&schema.toDouble()==1.0){"引用JSON版本不受支持"}
            val titles=listOf("originalTitle","title").mapNotNull{json.nullableString(it)}
            require(titles.isNotEmpty()&&titles.all{normalize(it)==normalize(paper.title)}){"原引用题名与当前论文不符"}
            require(json.getString("type")==if(paper.sourceKind=="arxiv")"preprint"else"conference-paper"){"引用JSON的出版类型与已核来源不符"}
            if(paper.sourceKind=="arxiv") {
                require(listOf("id","arxivVersionedId").mapNotNull{json.nullableString(it)}.any{it==paper.sourceVersion}){"原引用缺少当前原文版本"}
                require(json.optString("absUrl")==paper.sourceURL&&json.optString("pdfUrl")==paper.pdfURL){"原引用地址与当前原文版本不符"}
                if(json.has("arxivVersion")){val version=json.get("arxivVersion");require(version is Number&&version.toDouble()==version.toInt().toDouble()&&version.toInt()==paper.sourceVersion!!.substringAfterLast('v').toInt()){"原引用版本字段互相矛盾"}}
            }else require(json.optString("recordUrl")==paper.sourceURL&&(paper.pdfURL==null||json.optString("pdfUrl")==paper.pdfURL)){"会议引用原件地址与当前官方来源不符"}
        }
        private fun ris(text:String):Map<String,List<String>> {
            val fields=linkedMapOf<String,MutableList<String>>();var current:String?=null;var ended=false
            for(line in text.split(Regex("\\r\\n|\\n|\\r"))) {
                if(line.isBlank())continue
                require(!ended){"RIS包含不止一份引用或尾随内容"}
                val m=Regex("^([A-Z0-9]{2})  - ?(.*)$").matchEntire(line)
                if(m==null){require(line.startsWith("  ")&&current!=null){"RIS行格式无效"};val rows=fields.getValue(current!!);rows[rows.lastIndex]+=" "+line.trim();continue}
                val key=m.groupValues[1];val value=m.groupValues[2]
                if(fields.isEmpty())require(key=="TY"){"RIS缺少起始类型"}
                if(key in listOf("TY","TI","ID","UR","L1","ER"))require(!fields.containsKey(key)){"RIS关键身份字段重复"}
                fields.getOrPut(key){mutableListOf()}.add(value);current=key
                if(key=="ER"){require(value.isBlank());ended=true}
            }
            require(ended&&fields.containsKey("TY")){"RIS没有完整结束标记"};return fields
        }
        /** Decode only publisher-supported TeX escapes for identity checks; output bytes remain untouched. */
        private fun bibText(raw:String):String {
            val out=StringBuilder();var i=0
            while(i<raw.length){val c=raw[i++]
                if(c=='\\'){
                    val commands=mapOf("textbackslash{}" to "\\","textasciitilde{}" to "~","textasciicircum{}" to "^")
                    val command=commands.keys.firstOrNull{raw.startsWith(it,i)}
                    if(command!=null){out.append(commands.getValue(command));i+=command.length}
                    else {require(i<raw.length&&raw[i] in "\\{}%$#_&"){"BibTeX身份字段含不受支持的转义"};out.append(raw[i++])}
                }else if(c!='{'&&c!='}')out.append(c)
            };return out.toString()
        }
        private class Bib(private val text:String) {
            private var i=0
            private fun ws(){while(i<text.length&&text[i].isWhitespace())i++}
            private fun expect(c:Char){ws();require(i<text.length&&text[i++]==c){"BibTeX格式无效"}}
            private fun word():String{ws();val from=i;while(i<text.length&&(text[i].isLetterOrDigit()||text[i]=='_'))i++;require(i>from);return text.substring(from,i)}
            private fun value():String {
                ws();require(i<text.length)
                if(text[i]=='{'){
                    i++;val start=i;var depth=1
                    while(i<text.length){val c=text[i++];if(c=='\\'){require(i<text.length);i++}else if(c=='{')depth++else if(c=='}'){depth--;if(depth==0)return text.substring(start,i-1)}}
                    error("BibTeX值没有结束")
                }
                if(text[i]=='"'){
                    i++;val start=i;var depth=0
                    while(i<text.length){val c=text[i++];if(c=='\\'){require(i<text.length);i++}else if(c=='{')depth++else if(c=='}'){depth--;require(depth>=0)}else if(c=='"'&&depth==0)return text.substring(start,i-1)}
                    error("BibTeX值没有结束")
                }
                val start=i;while(i<text.length&&text[i].isDigit())i++;require(i>start){"BibTeX未展开宏或拼接值不作为原件身份"};return text.substring(start,i)
            }
            private fun parse():Pair<String,Map<String,String>> {
                expect('@');val type=word().lowercase();require(type in listOf("misc","inproceedings")){"BibTeX引用类型不受支持"};expect('{')
                ws();val start=i;while(i<text.length&&text[i]!=',')i++;require(i<text.length&&text.substring(start,i).trim().matches(Regex("[A-Za-z0-9_:.+/-]{1,256}")));i++
                val fields=linkedMapOf<String,String>()
                while(true){ws();require(i<text.length);if(text[i]=='}'){i++;break};val key=word().lowercase();require(!fields.containsKey(key)){"BibTeX字段重复"};expect('=');fields[key]=value();ws();require(i<text.length);if(text[i]==',')i++else require(text[i]=='}'){"BibTeX字段边界无效"}}
                ws();require(i==text.length){"BibTeX包含其他引用或尾随内容"};return type to fields
            }
            companion object {fun parse(text:String)=Bib(text).parse()}
        }
        /** Strict JSON on both Android and JRE: no duplicate keys/comments/loose quotes/trailing objects. */
        private class StrictJson(private val text:String) {
            private var i=0;private var nodes=0
            private fun ws(){while(i<text.length&&text[i] in " \t\r\n")i++}
            private fun expect(c:Char){ws();require(i<text.length&&text[i++]==c){"引用JSON格式无效"}}
            private fun string():String {
                expect('"');val result=StringBuilder()
                while(i<text.length){val c=text[i++];if(c=='"')return result.toString();require(c>=' ')
                    if(c!='\\'){require(!c.isSurrogate()||c.isHighSurrogate()&&i<text.length&&text[i].isLowSurrogate()){ "引用JSON字符无效" };result.append(c);if(c.isHighSurrogate())result.append(text[i++]);continue}
                    require(i<text.length);when(val escaped=text[i++]){
                        '"','\\','/'->result.append(escaped);'b'->result.append('\b');'f'->result.append('\u000c');'n'->result.append('\n');'r'->result.append('\r');'t'->result.append('\t')
                        'u'->{fun hex():Char {require(i+4<=text.length);val value=text.substring(i,i+4).toIntOrNull(16)?:error("引用JSON转义无效");i+=4;return value.toChar()};val first=hex();if(first.isHighSurrogate()){require(i+2<=text.length&&text.substring(i,i+2)=="\\u");i+=2;val second=hex();require(second.isLowSurrogate());result.append(first).append(second)}else{require(!first.isLowSurrogate());result.append(first)}}
                        else->error("引用JSON转义无效")
                    }
                };error("引用JSON字符串未结束")
            }
            private fun value(depth:Int):Any {
                require(depth<=64&&++nodes<=100000){"引用JSON结构超过安全范围"};ws();require(i<text.length)
                return when(text[i]){
                    '{'->{i++;val obj=JSONObject();ws();if(i<text.length&&text[i]=='}'){i++;obj}else{while(true){val key=string();require(!obj.has(key)){"引用JSON字段重复"};expect(':');obj.put(key,value(depth+1));ws();require(i<text.length);if(text[i]=='}'){i++;break};expect(',')};obj}}
                    '['->{i++;val array=JSONArray();ws();if(i<text.length&&text[i]==']'){i++;array}else{while(true){array.put(value(depth+1));ws();require(i<text.length);if(text[i]==']'){i++;break};expect(',')};array}}
                    '"'->string()
                    't'->{require(text.startsWith("true",i));i+=4;true}
                    'f'->{require(text.startsWith("false",i));i+=5;false}
                    'n'->{require(text.startsWith("null",i));i+=4;JSONObject.NULL}
                    else->{val match=Regex("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?").find(text,i);require(match!=null&&match.range.first==i);i=match.range.last+1;val n=JSONObject("{\"n\":"+match.value+"}").get("n");require(n is Number&&n.toDouble().isFinite());n}
                }
            }
            companion object {fun parse(text:String):JSONObject {val p=StrictJson(text);val value=p.value(0);p.ws();require(p.i==text.length&&value is JSONObject){"引用JSON含尾随内容或不是对象"};return value}}
        }
    }
}
