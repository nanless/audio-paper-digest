import AppKit
import WebKit
import PDFKit
import UniformTypeIdentifiers

@MainActor extension PaperDigestApp {
    static func archiveIdentity(paperID:String,sourceVersion:String?) throws -> String {
        guard paperID.hasPrefix("arxiv:") else{return paperID}
        let base=String(paperID.dropFirst("arxiv:".count))
        guard DesktopArxivIdentifier.isBase(base) else{throw DesktopError.message("论文 arXiv 身份格式无效，未准备归档")}
        guard let version=sourceVersion,!version.isEmpty,version != base else{return paperID}
        guard DesktopArxivIdentifier.base(of:version)==base else{throw DesktopError.message("原文版本与论文身份不一致或格式无效，未准备归档")}
        return "arxiv:"+version
    }
    func verifyArticleBinding(_ article:[String:Any],paper:[String:Any]) throws {
        guard article["paperID"] as? String==paper["id"] as? String,
              article["sourceURL"] as? String==(paper["sourceURL"] as? String ?? paper["blogURL"] as? String),
              article["sourceVersion"] as? String==paper["sourceVersion"] as? String,
              article["pdfURL"] as? String==paper["pdfURL"] as? String else{throw DesktopError.message("网站目录或来源版本已更新；旧阅读资料保留，请从资料库重新打开当前版本")}
    }
    func verifyPDFBinding(_ pdf:[String:Any],paper:[String:Any],article:[String:Any]) throws {
        guard let address=paper["pdfURL"] as? String,pdf["sourceURL"] as? String==address,
              pdf["version"] as? String==paper["sourceVersion"] as? String else{throw DesktopError.message("原文来源版本与当前阅读身份不同，未把新版本 PDF 放入旧导读或归档；请从资料库重新打开")}
        if let expected=paper["pdfSHA256"] as? String,pdf["sha256"] as? String != expected{throw DesktopError.message("原文内容与当前阅读目录的公开 SHA 不一致")}
        if paper["sourceVersion"] as? String==nil,paper["pdfSHA256"] as? String==nil,article["offlineMode"] as? Bool != true {
            guard let epoch=article["catalogEpoch"] as? String,epoch==pdf["catalogEpoch"] as? String else{throw DesktopError.message("未提供固定版本的原文和导读须来自同次目录核验；请先重新打开网站当前导读")}
        }
    }
    func validateSettings(_ value:[String:Any]) throws {
        for key in ["appearance","endpoint","model","protocol","httpProxy"]{if let item=value[key],!(item is String){throw DesktopError.message("设置字段类型无效："+key)}}
        for key in ["reduceMotion","responsesStream"]{if let flag=value[key],!(flag is NSNumber) || CFGetTypeID(flag as CFTypeRef) != CFBooleanGetTypeID(){throw DesktopError.message("布尔设置无效："+key)}}
        if let effort=value["reasoningEffort"]{guard let text=effort as? String,["default","low","medium","high"].contains(text) else{throw DesktopError.message("Responses 推理强度设置无效")}}
        if let item=value["protocol"] as? String,!["auto","responses","chat"].contains(item){throw DesktopError.message("请求协议选项无效")}
        for key in ["endpoint","httpProxy"] {if let raw=value[key] as? String,!raw.isEmpty {guard let url=URL(string:raw),url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,url.host != nil else{throw DesktopError.message("端点和代理不得携带凭据、查询参数或片段")};if key=="httpProxy" {guard url.scheme=="http",url.port != nil else{throw DesktopError.message("代理须为带端口的 HTTP CONNECT 地址")}}else{guard url.scheme=="https" || (url.scheme=="http" && ["127.0.0.1","localhost","::1"].contains(url.host!)) else{throw DesktopError.message("模型端点须为 HTTPS，本机服务可用 HTTP")}}}}
        let ranges=["font":16...24,"syncHours":1...168,"maxTokens":256...32768,"dailyRequests":1...1000]
        for(key,range) in ranges {if let item=value[key] {guard let number=item as? Int,CFGetTypeID(item as CFTypeRef) != CFBooleanGetTypeID(),range.contains(number) else{throw DesktopError.message("设置数值超出允许范围："+key)}}}
        if let appearance=value["appearance"] as? String,!["system","light","dark"].contains(appearance){throw DesktopError.message("外观选项无效")}
        if let model=value["model"] as? String,model.count>200{throw DesktopError.message("模型名称过长")}
    }
    func showSettingsWindow() {
        if let existing=settingsWindow {existing.makeKeyAndOrderFront(nil);return}
        let sheet=NSWindow(contentRect:NSRect(x:0,y:0,width:780,height:610),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        sheet.title="论文速递设置";sheet.minSize=NSSize(width:700,height:520);sheet.isReleasedWhenClosed=false;sheet.delegate=self
        let config=WKWebViewConfiguration();config.setURLSchemeHandler(scheme,forURLScheme:"paperapp");config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"desktop")
        let view=WKWebView(frame:sheet.contentView!.bounds,configuration:config);view.autoresizingMask=[.width,.height];view.navigationDelegate=self;sheet.contentView=view;settingsWeb=view;settingsWindow=sheet
        view.load(URLRequest(url:URL(string:"paperapp://app/settings.html")!));sheet.center();sheet.makeKeyAndOrderFront(nil)
    }
    func importLocalPDF() throws {
        guard !terminationPending,!maintenanceBusy else{throw DesktopError.message("正在退出或整理资料，未打开其他来源")}
        maintenanceBusy=true;defer{maintenanceBusy=false}
        let panel=NSOpenPanel();panel.allowedContentTypes=[.pdf];panel.allowsMultipleSelection=false;panel.message="原件复制到个人研究空间，不修改源文件"
        guard panel.runModal() == .OK,let source=panel.url else{return}
        let bytes=try PrivateStoragePaths.boundedData(source,limit:200*1024*1024);guard let document=PDFDocument(data:bytes) else{throw DesktopError.message("文件不是有效 PDF，或超过 200 MB")}
        try unlockPDF(document)
        let hash=sha256(bytes),folder=directory.appendingPathComponent("Imports",isDirectory:true);try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let target=folder.appendingPathComponent(hash+".pdf");try bytes.write(to:target,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:target.path)
        let importedID="local:"+hash
        let imported:[String:Any]=["id":importedID,"localPDFPath":target.path,"pdfSHA":hash,"title":source.deletingPathExtension().lastPathComponent,"titleZh":source.deletingPathExtension().lastPathComponent,"sourceKind":"local","identityStatus":"unverified","authors":[],"tags":[]]
        try store.rememberPaper(imported);contextGeneration+=1;pdfVersion="";currentPDFReceipt=[:];pendingPDFPage=1;annotationsByID=[:];currentPaperID=importedID;currentPaper=imported;currentArticle=[:];selectionSource=[:];currentPDFSHA=hash;pdfOwner=currentPaperID;currentPDFPath=target;pdfView.document=document
        emit("local.opened",["paper":currentPaper,"pdf":pdfStatus()])
    }
    func unlockPDF(_ document:PDFDocument,passwordProvider:(()->String?)?=nil) throws {
        guard document.isLocked else{return}
        let password:String?
        if let provider=passwordProvider{password=provider()}else{
            let alert=NSAlert();alert.messageText="此 PDF 需要密码";alert.informativeText="密码仅用于此次打开，不保存到文件或钥匙串。"
            let field=NSSecureTextField(frame:NSRect(x:0,y:0,width:260,height:24));alert.accessoryView=field;alert.addButton(withTitle:"解锁");alert.addButton(withTitle:"取消")
            password=alert.runModal() == .alertFirstButtonReturn ? field.stringValue:nil
        }
        guard let password,document.unlock(withPassword:password),!document.isLocked else{throw DesktopError.message("PDF 未解锁；没有替换当前阅读资料")}
    }
    func archiveMaterials(_ payload:[String:Any],includeAnalysis:Bool=true) async throws->[String:Any] {
        let captured=currentPaperID,paper=currentPaper,generation=contextGeneration
        try await flushEdits()
        try Task.checkCancellation()
        guard captured==currentPaperID,generation==contextGeneration else{throw DesktopError.message("保存期间论文已切换，未准备其他论文的材料")}
        guard !currentPaperID.isEmpty,!currentPaperID.hasPrefix("local:") else{throw DesktopError.message("请先选取已发布论文；本地 PDF 缺少已核验书目，仍可解析及导出个人研究")}
        if currentArticle["paperID"] as? String != captured {let loaded=try await library.handle(command:"library.article",payload:["paperID":captured]);guard captured==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换")};try Task.checkCancellation();try verifyArticleBinding(loaded,paper:paper);currentArticle=loaded}
        let article=currentArticle
        try verifyArticleBinding(article,paper:paper)
        if article["isStale"] as? Bool==true, (article["sourceVersion"] as? String != paper["sourceVersion"] as? String || article["sourceURL"] as? String != paper["sourceURL"] as? String){throw DesktopError.message("当前离线导读属于旧来源版本；请完成新版本读取后归档，旧稿仍可阅读") }
        guard captured==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，请重新准备归档")}
        var citation=article["citation"] as? [String:Any] ?? paper["citation"] as? [String:Any] ?? [:]
        let sidecar=article["citationSidecar"] as? [String:Any] ?? [:],context=article["researchContext"] as? [String:Any] ?? [:]
        let sourceRecord=sidecar["source"] as? [String:Any] ?? sidecar["citation"] as? [String:Any] ?? sidecar
        for(key,value) in sourceRecord {if !(value is NSNull){citation[key]=value}}
        let fullSource:[String:Any]=["publishedCitation":article["citation"] ?? [:],"citationSidecar":sidecar,"researchContext":context,"paper":paper,"articleRevision":article["revisionSHA256"] ?? ""]
        let authorObjects=citation["authors"] as? [[String:Any]] ?? []
        let names=authorObjects.isEmpty ? (citation["authors"] as? [String] ?? paper["authors"] as? [String] ?? []) : authorObjects.compactMap{$0["name"] as? String}
        var bibliography:[String:Any]=["title":citation["originalTitle"] as? String ?? citation["title"] as? String ?? paper["title"] as? String ?? "","creators":names.map{["name":$0]},"abstract":context["abstract"] as? String ?? citation["abstract"] as? String ?? "","date":citation["date"] as? String ?? "","url":citation["absUrl"] as? String ?? citation["sourceUrl"] as? String ?? article["sourceURL"] as? String ?? "","extra":"PaperDigest source metadata\n"+(String(data:try JSONSerialization.data(withJSONObject:fullSource,options:[.sortedKeys,.prettyPrinted]),encoding:.utf8) ?? ""),"tags":paper["tags"] as? [String] ?? [],"fields":[:]]
        var fields:[String:String]=[:]
        let declaredType=citation["type"] as? String ?? ""
        let mapping=["article-journal":"journalArticle","journalArticle":"journalArticle","journal-article":"journalArticle","paper-conference":"conferencePaper","conferencePaper":"conferencePaper","preprint":"preprint","webpage":"webpage"]
        if let type=mapping[declaredType]{fields["itemType"]=type}
        for key in ["volume","issue","pages","language","publicationTitle","proceedingsTitle","publisher","place","series","conferenceName","ISSN","ISBN"] {if let text=citation[key] as? String,!text.isEmpty{fields[key]=text}}
        if let venue=citation["venue"] as? String,!venue.isEmpty {if fields["itemType"]=="journalArticle"{fields["publicationTitle"]=venue}else if fields["itemType"]=="conferencePaper"{fields["proceedingsTitle"]=venue}}
        bibliography["fields"]=fields
        if captured.hasPrefix("page:"){bibliography["url"]=paper["blogURL"] ?? ""}
        if let doi=citation["doi"] as? String,!doi.isEmpty{bibliography["doi"]=doi}
        var result:[String:Any]=["identity":try Self.archiveIdentity(paperID:captured,sourceVersion:paper["sourceVersion"] as? String),"bibliography":bibliography]
        do {let pdf:[String:Any];if article["offlineMode"] as? Bool==true{guard let identifier=paper["offlinePackageID"] as? String else{throw DesktopError.message("离线包身份缺失")};let checked=try await storage.openPackage(id:identifier);guard let saved=checked["pdf"] as? [String:Any],saved["sha256"] as? String==offlinePDF?["sha256"] as? String else{throw DesktopError.message("离线包不含已核验的原始 PDF")};pdf=saved}else{pdf=try await library.handle(command:"library.downloadPDF",payload:["paperID":captured])};try verifyPDFBinding(pdf,paper:paper,article:article);guard pdf["isStale"] as? Bool != true else{throw DesktopError.message("原文复验失败，旧缓存未作为当前来源归档")};result["pdfPath"]=pdf["filePath"]}catch{if Task.isCancelled || error is CancellationError{throw CancellationError()};result["pdfNotice"]=error.localizedDescription}
        try Task.checkCancellation()
        let exports=directory.appendingPathComponent("Exports",isDirectory:true);try FileManager.default.createDirectory(at:exports,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        // Only the sandbox-rendered, script-free article may be supplied here; native service
        // validates every resource again before any Zotero write.
        let rendered=try await web.evaluateJavaScript("window.paperDigestArchiveHTML ? window.paperDigestArchiveHTML() : null") as? [String:Any]
        guard captured==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换")}
        if let rendered=rendered,rendered["paperID"] as? String==captured,rendered["revision"] as? String==article["revisionSHA256"] as? String,let body=rendered["html"] as? String,!body.isEmpty,article["completeOffline"] as? Bool==true {
            let html="<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>"+htmlEscape(bibliography["title"] as? String ?? "")+"</title><style>body{font:18px/1.85 -apple-system,sans-serif;max-width:850px;margin:60px auto;padding:0 32px;color:#252b30}img{max-width:100%;height:auto}table{border-collapse:collapse;display:block;overflow:auto}td,th{padding:8px;border:1px solid #ccd1d5}pre{white-space:pre-wrap}math{font-size:1.1em}a{color:#256d73}</style></head><body>"+body+"</body></html>"
            let file=exports.appendingPathComponent(sha256(Data(html.utf8))+".html");try Data(html.utf8).write(to:file,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path);result["guideHTMLPath"]=file.path
        }
        let personal=store.snapshot(),notes=personal["notes"] as? [String:[String:Any]] ?? [:]
        let text=notes[captured]?["text"] as? String ?? "",marks=store.annotations(id:captured)
        if !text.isEmpty || !marks.isEmpty {
            var note=["<div><h2>个人研究笔记</h2><pre>"+htmlEscape(text)+"</pre>"]
            for mark in marks {let page=mark["page"] as? Int ?? 0,quote=htmlEscape(mark["text"] as? String ?? ""),comment=htmlEscape(mark["comment"] as? String ?? ""),hash=htmlEscape(mark["pdfSHA"] as? String ?? "");note.append("<h3>原文摘录 · 物理页 \(page)</h3><blockquote>"+quote+"</blockquote><p>我的批注："+comment+"</p><p>PDF SHA256："+hash+"</p>")};note.append("</div>");result["noteHTML"]=note.joined()
        }
        let sessions=(personal["sessions"] as? [[String:Any]] ?? []).filter{$0["paperID"] as? String==captured && $0["status"] as? String=="complete" && $0["kind"] as? String != "connection-check"}
        if includeAnalysis && !sessions.isEmpty {
            do {
            var parts=["<div><h2>个人模型解析</h2>"]
            for entry in sessions {
                let question=htmlEscape(entry["question"] as? String ?? ""),model=htmlEscape(entry["actualModel"] as? String ?? ("请求模型："+(entry["model"] as? String ?? "未指定")+"；服务未返回实际模型")),time=htmlEscape(entry["startedAt"] as? String ?? ""),text=htmlEscape(entry["text"] as? String ?? "")
                let evidence=try self.model.exportEvidence(sessionID:entry["id"] as? String ?? "",paperID:captured)
                let provenance:[String:Any]=["source":evidence["source"] ?? NSNull(),"evidenceAvailable":evidence["available"] ?? false,"evidenceNotice":evidence["notice"] ?? "","inputSHA256":entry["inputSHA256"] ?? NSNull(),"usage":entry["usage"] ?? NSNull(),"fingerprint":entry["fingerprint"] ?? "","requestedModel":entry["model"] ?? "","actualModel":entry["actualModel"] ?? NSNull(),"protocol":entry["protocol"] ?? "","endedAt":entry["endedAt"] ?? "","responsesStream":entry["responsesStream"] ?? NSNull(),"reasoningEffort":entry["reasoningEffort"] ?? NSNull(),"maxTokens":entry["maxTokens"] ?? NSNull(),"finishStatus":entry["finishStatus"] ?? NSNull()]
                let detail=htmlEscape(String(data:try JSONSerialization.data(withJSONObject:provenance,options:[.prettyPrinted,.sortedKeys]),encoding:.utf8) ?? "")
                parts.append("<h3>"+question+"</h3><p>"+model+" · "+time+"</p><pre>"+text+"</pre><pre>"+detail+"</pre>")
                parts.append("<h4>本次实际研究材料</h4><pre>"+htmlEscape(evidence["evidence"] as? String ?? evidence["notice"] as? String ?? "原材料未保存")+"</pre>")
            }
            parts.append("</div>");result["analysisHTML"]=parts.joined()
            } catch {
                result["analysisNotice"]="个人解析的原材料校验未通过，未准备此项："+error.localizedDescription
            }
        }

        try Task.checkCancellation()
        guard captured==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，归档材料没有提交")};return result
    }
    func buildCurrentExport(_ payload:[String:Any]) async throws -> (data:Data,ext:String,title:String) {
        let id=currentPaperID,generation=contextGeneration,paper=currentPaper,article=currentArticle
        guard !id.isEmpty else{throw DesktopError.message("请先选择论文")}
        try await flushEdits()
        try Task.checkCancellation()
        guard id==currentPaperID,generation==contextGeneration else{throw DesktopError.message("保存期间论文已切换，未导出其他论文")}
        let kind=payload["format"] as? String ?? "markdown",title=paper["title"] as? String ?? "个人研究"
        var data:Data,ext:String
        let notes=(store.value["notes"] as? [String:[String:Any]])?[id]?["text"] as? String ?? ""
        let sessions=try (store.value["sessions"] as? [[String:Any]] ?? []).filter{$0["paperID"] as? String==id && $0["kind"] as? String != "connection-check"}.map { entry in
            var exported=entry.filter { ["id","kind","paperID","question","text","response","error","source","model","actualModel","protocol","startedAt","endedAt","usage","status","fingerprint","inputSHA256","charge","responsesStream","reasoningEffort","maxTokens","finishStatus","requestIssued","parentSessionID","reused"].contains($0.key) }
            if !["bib","ris","citation","guide","pdf"].contains(kind) {
                let evidence=try model.exportEvidence(sessionID:entry["id"] as? String ?? "",paperID:id)
                exported["sealedEvidence"]=evidence
                exported["source"]=evidence["source"] ?? NSNull()
            }
            return exported
        }
        let provenance=try JSONSerialization.data(withJSONObject:sessions.map{entry in entry.filter{["id","kind","question","source","model","actualModel","protocol","startedAt","endedAt","usage","status","fingerprint","inputSHA256","charge","responsesStream","reasoningEffort","maxTokens","finishStatus"].contains($0.key)}},options:[.prettyPrinted,.sortedKeys])
        let provenanceText=String(data:provenance,encoding:.utf8) ?? ""
        let annotations=store.annotations(id:id)
        let annotationText=annotations.map{mark in "### 原文摘录 · 物理页 \(mark["page"] as? Int ?? 0)\n\n"+(mark["text"] as? String ?? "")+"\n\n我的批注："+(mark["comment"] as? String ?? "")+"\n\nPDF SHA256："+(mark["pdfSHA"] as? String ?? "")+"\n"}.joined(separator:"\n")
        let text="# \(title)\n\n身份：\(id)\n\n## 个人笔记\n\n\(notes)\n\n"+sessions.map { entry in
            let evidence=entry["sealedEvidence"] as? [String:Any] ?? [:]
            return "## "+(entry["question"] as? String ?? "")+"\n\n"+(entry["text"] as? String ?? "[请求未完成]")+"\n\n### 本次实际研究材料\n\n"+(evidence["evidence"] as? String ?? evidence["notice"] as? String ?? "原材料未保存")+"\n\n"
        }.joined(separator:"\n")+"\n## 原文摘录与我的批注\n\n"+annotationText+"\n## 来源与实际请求记录\n\n```json\n"+provenanceText+"\n```\n"
        if ["bib","ris","citation"].contains(kind){let source=try await library.handle(command:"library.citationFile",payload:["paperID":id,"format":kind=="citation" ? "json":kind]);guard let content=source["text"] as? String else{throw DesktopError.message("真实引用文件不可读")};data=Data(content.utf8);ext=kind=="citation" ? "json":kind}
        else if kind=="guide"{let materials=try await archiveMaterials([:],includeAnalysis:false);guard let path=materials["guideHTMLPath"] as? String else{throw DesktopError.message("请先等待完整图文导读缓存，无法导出缺图副本")};data=try Data(contentsOf:URL(fileURLWithPath:path));ext="html"}
        else if kind=="pdf"{guard pdfOwner==id,let path=currentPDFPath else{throw DesktopError.message("请先打开当前原文 PDF")};data=try Data(contentsOf:path);guard sha256(data)==currentPDFSHA else{throw DesktopError.message("原始 PDF 在打开后被修改，未将改变的文件导出为原版本")};ext="pdf"}
        else if kind=="html"{data=Data(("<!doctype html><html><meta charset=\"utf-8\"><title>个人研究</title><body><pre>"+htmlEscape(text)+"</pre></body></html>").utf8);ext="html"}
        else if kind=="json"{data=try JSONSerialization.data(withJSONObject:["paper":paper,"article":article,"notes":notes,"sessions":sessions,"annotations":store.annotations(id:id)],options:[.prettyPrinted,.sortedKeys]);ext="json"}
        else {data=Data(text.utf8);ext="md"}
        guard id==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，导出未写入")}
        try Task.checkCancellation()
        return (data:data,ext:ext,title:title)
    }
    func exportCurrent(_ payload:[String:Any]) async throws {
        let owner=currentPaperID,generation=contextGeneration
        let built=try await buildCurrentExport(payload)
        guard owner==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，未保存其他论文的导出")}
        let (data,ext,title)=built
        let panel=NSSavePanel();panel.nameFieldStringValue=String(title.prefix(70)).replacingOccurrences(of:"/",with:"-")+"."+ext
        guard panel.runModal() == .OK,let url=panel.url else{throw DesktopError.message("已取消导出")};try Task.checkCancellation()
        guard owner==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，导出未写入")}
        try data.write(to:url,options:.atomic)
    }
    func backupData() throws {
        guard !terminationPending,!maintenanceBusy else{throw DesktopError.message("正在退出或整理资料，未开始备份")}
        maintenanceBusy=true;defer{maintenanceBusy=false}
        guard jobs.isEmpty else{throw DesktopError.message("请待当前任务结束再备份，保证资料和任务检查点属于同一快照")}
        let payload=try BackupCodec.collect(sourceDirectory:directory)
        let panel=NSSavePanel();panel.nameFieldStringValue="论文速递-"+ISO8601DateFormatter().string(from:Date()).replacingOccurrences(of:":",with:"-")+".paperdigest"
        guard panel.runModal() == .OK,let url=panel.url else{throw DesktopError.message("已取消备份")}
        try BackupCodec.encode(payload).write(to:url,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
    }
    func restoreData() throws {
        guard !terminationPending,!maintenanceBusy else{throw DesktopError.message("正在退出或整理资料，未开始恢复")}
        maintenanceBusy=true;defer{maintenanceBusy=false}
        guard jobs.isEmpty else{throw DesktopError.message("请先结束任务再恢复资料")}
        let panel=NSOpenPanel();panel.allowsMultipleSelection=false;guard panel.runModal() == .OK,let url=panel.url else{throw DesktopError.message("已取消恢复")}
        guard let count=try url.resourceValues(forKeys:[.fileSizeKey]).fileSize,count<=750*1024*1024 else{throw DesktopError.message("备份大小超过限制")}
        let payload=try BackupCodec.parse(Data(contentsOf:url))
        let fm=FileManager.default,parent=directory.deletingLastPathComponent(),old=parent.appendingPathComponent("PaperDigest-before-restore-"+UUID().uuidString)
        let staged=try BackupCodec.stage(payload,parentDirectory:parent),stage=staged.stageDirectory
        defer{try? fm.removeItem(at:stage)}
        let stagedStore=try DesktopStore(directory:stage);try validateSettings(stagedStore.value["settings"] as? [String:Any] ?? [:]);_=try LibraryService(dataDirectory:stage)
        let alert=NSAlert();alert.messageText="恢复个人研究空间？";alert.informativeText="全部文件已通过 SHA 校验。当前资料将保存在同目录旁的恢复前副本中；API 与 Zotero 钥匙串授权不随备份迁移。";alert.addButton(withTitle:"恢复并重新载入");alert.addButton(withTitle:"取消");guard alert.runModal() == .alertFirstButtonReturn else{throw DesktopError.message("已取消恢复")}
        try fm.moveItem(at:directory,to:old)
        do{try fm.moveItem(at:stage,to:directory)}catch{try? fm.moveItem(at:old,to:directory);throw error}
        do{
            let restoredStore=try DesktopStore(directory:directory),restoredLibrary=try LibraryService(dataDirectory:directory),restoredZotero=ZoteroService(dataDirectory:directory),restoredModel=ModelService(directory:directory,store:restoredStore)
            store=restoredStore;library=restoredLibrary;zotero=restoredZotero;model=restoredModel;storage=DesktopStorage(directory:directory,store:restoredStore)
        }catch{
            let failed=parent.appendingPathComponent("PaperDigest-failed-restore-"+UUID().uuidString)
            try fm.moveItem(at:directory,to:failed);try fm.moveItem(at:old,to:directory);throw error
        }
        configureSchedule()
        contextGeneration+=1;pdfView.document=nil;pdfView.isHidden=true;currentPaper=[:];currentPaperID="";pdfOwner="";pdfVersion="";currentPDFSHA="";currentPDFPath=nil;annotationsByID=[:];currentArticle=[:];selectionSource=[:];offlinePDF=nil;currentPDFReceipt=[:];emit("personal.changed")
    }
    func diagnostics() throws {
        let jobs=store.value["jobs"] as? [[String:Any]] ?? [],report:[String:Any]=["app":"论文速递","version":"1.0.0","system":ProcessInfo.processInfo.operatingSystemVersionString,"counts":["jobs":jobs.count,"notes":(store.value["notes"] as? [String:Any])?.count ?? 0,"sessions":(store.value["sessions"] as? [Any])?.count ?? 0],"jobStates":jobs.map{["command":$0["command"] ?? "","status":$0["status"] ?? ""]},"credentialsIncluded":false,"personalTextIncluded":false]
        let panel=NSSavePanel();panel.nameFieldStringValue="论文速递诊断.json";guard panel.runModal() == .OK,let url=panel.url else{throw DesktopError.message("已取消导出")};try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:url,options:.atomic)
    }
}
