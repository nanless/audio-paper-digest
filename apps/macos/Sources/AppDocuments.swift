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
    func showSettingsWindow(initialPane:String?=nil) {
        if let initialPane{settingsPaneRequestID=UUID();settingsPaneRequest=initialPane}
        if let existing=settingsWindow {existing.makeKeyAndOrderFront(nil);applySettingsPaneRequest();return}
        let sheet=NSWindow(contentRect:NSRect(x:0,y:0,width:780,height:610),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        sheet.title="论文速递工作台设置";sheet.minSize=NSSize(width:700,height:520);sheet.isReleasedWhenClosed=false;sheet.delegate=self
        let config=WKWebViewConfiguration();config.setURLSchemeHandler(scheme,forURLScheme:"paperapp");config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"desktop")
        let view=WKWebView(frame:sheet.contentView!.bounds,configuration:config);view.autoresizingMask=[.width,.height];view.navigationDelegate=self;sheet.contentView=view;settingsWeb=view;settingsWindow=sheet
        view.load(URLRequest(url:URL(string:"paperapp://app/settings.html")!));sheet.center();sheet.makeKeyAndOrderFront(nil)
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) {
        if webView===settingsWeb{applySettingsPaneRequest()}
    }
    func applySettingsPaneRequest(documentReady:Bool=false) {
        guard let pane=settingsPaneRequest,let view=settingsWeb,(documentReady || !view.isLoading),
              view.url?.scheme=="paperapp",view.url?.host=="app",view.url?.path=="/settings.html" else{return}
        let requestID=settingsPaneRequestID
        Task{@MainActor [weak self,weak view] in
            guard let self,let view,self.settingsWeb===view,self.settingsPaneRequestID==requestID,self.settingsPaneRequest==pane,(documentReady || !view.isLoading) else{return}
            do{
                let applied=try await view.callAsyncJavaScript("return typeof window.paperDigestShowSettingsPane === 'function' ? window.paperDigestShowSettingsPane(pane) : false",arguments:["pane":pane],in:nil,contentWorld:.page)
                if self.settingsWeb===view,self.settingsPaneRequestID==requestID,self.settingsPaneRequest==pane,applied as? Bool==true{self.settingsPaneRequest=nil}
            }catch{if self.settingsWeb===view,self.settingsPaneRequestID==requestID,self.settingsPaneRequest==pane{self.emit("app.error",["message":"未能定位设置分类，请在设置窗口中选择"]);self.settingsPaneRequest=nil}}
        }
    }
    func importLocalPDF() throws {
        try requireMainContextAvailable()
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
        guard let password else{throw DesktopOperationCancelled("已取消打开加密 PDF；原阅读资料保留")}
        guard document.unlock(withPassword:password),!document.isLocked else{throw DesktopError.message("PDF 未解锁；没有替换当前阅读资料")}
    }
    func archiveMaterials(_ payload:[String:Any],includeAnalysis:Bool=true,access:DetailDocumentAccess?=nil) async throws->[String:Any] {
        try requireDocumentContext(access,kinds:[.zotero,.export])
        let captured=currentPaperID,paper=currentPaper,generation=contextGeneration
        try await flushEdits()
        try Task.checkCancellation()
        try requireDocumentContext(access,kinds:[.zotero,.export])
        guard captured==currentPaperID,generation==contextGeneration else{throw DesktopError.message("保存期间论文已切换，未准备其他论文的材料")}
        guard !currentPaperID.isEmpty,!currentPaperID.hasPrefix("local:") else{throw DesktopError.message("请先选取已发布论文；本地 PDF 缺少已核验书目，仍可解析及导出个人研究")}
        if currentArticle["paperID"] as? String != captured {let loaded=try await library.handle(command:"library.article",payload:["paperID":captured]);guard captured==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换")};try Task.checkCancellation();try requireDocumentContext(access,kinds:[.zotero,.export]);try verifyArticleBinding(loaded,paper:paper);currentArticle=loaded}
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
        try requireDocumentContext(access,kinds:[.zotero,.export])
        let exports=directory.appendingPathComponent("Exports",isDirectory:true);try FileManager.default.createDirectory(at:exports,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        // Only the sandbox-rendered, script-free article may be supplied here; native service
        // validates every resource again before any Zotero write.
        let rendered=try await web.evaluateJavaScript("window.paperDigestArchiveHTML ? window.paperDigestArchiveHTML() : null") as? [String:Any]
        try requireDocumentContext(access,kinds:[.zotero,.export])
        guard captured==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换")}
        if let rendered=rendered,rendered["paperID"] as? String==captured,rendered["revision"] as? String==article["revisionSHA256"] as? String,let body=rendered["html"] as? String,!body.isEmpty,article["completeOffline"] as? Bool==true {
            let html="<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>"+htmlEscape(bibliography["title"] as? String ?? "")+"</title><style>body{font:18px/1.85 -apple-system,sans-serif;max-width:850px;margin:60px auto;padding:0 32px;color:#252b30}body>.eyebrow+h1{font-size:31px;line-height:1.42;letter-spacing:-.6px;margin:10px 0 18px;text-wrap:balance}img{max-width:100%;height:auto}table{border-collapse:collapse;display:block;overflow:auto}td,th{padding:8px;border:1px solid #ccd1d5}pre{white-space:pre-wrap}math{font-size:1.1em}.katex:has(>math[display=block]),.math-scroll:has(>math[display=block]){display:block;max-width:100%;overflow-x:auto}.katex:has(>math[display=block])::-webkit-scrollbar,.math-scroll:has(>math[display=block])::-webkit-scrollbar{height:10px}.katex:has(>math[display=block])::-webkit-scrollbar-track,.math-scroll:has(>math[display=block])::-webkit-scrollbar-track{background:light-dark(#e6e9ed,#343a42);border-radius:5px}.katex:has(>math[display=block])::-webkit-scrollbar-thumb,.math-scroll:has(>math[display=block])::-webkit-scrollbar-thumb{background:light-dark(#8794a3,#9ba9ba);border-radius:5px}.katex:has(>math[display=block]):focus-visible,.math-scroll:has(>math[display=block]):focus-visible{outline:2px solid light-dark(#3468cf,#98b8ff);outline-offset:2px}a{color:#256d73}</style></head><body>"+body+"</body></html>"
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
        try requireDocumentContext(access,kinds:[.zotero,.export])
        guard captured==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，归档材料没有提交")};return result
    }
    func buildCurrentExport(_ payload:[String:Any],access:DetailDocumentAccess?=nil) async throws -> (data:Data,ext:String,title:String) {
        try requireDocumentContext(access,kinds:[.export])
        let id=currentPaperID,generation=contextGeneration,paper=currentPaper,article=currentArticle
        guard !id.isEmpty else{throw DesktopError.message("请先选择论文")}
        try await flushEdits()
        try Task.checkCancellation()
        try requireDocumentContext(access,kinds:[.export])
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
        else if kind=="guide"{let materials=try await archiveMaterials([:],includeAnalysis:false,access:access);guard let path=materials["guideHTMLPath"] as? String else{throw DesktopError.message("请先等待完整图文导读缓存，无法导出缺图副本")};data=try Data(contentsOf:URL(fileURLWithPath:path));ext="html"}
        else if kind=="pdf"{guard pdfOwner==id,let path=currentPDFPath else{throw DesktopError.message("请先打开当前原文 PDF")};data=try Data(contentsOf:path);guard sha256(data)==currentPDFSHA else{throw DesktopError.message("原始 PDF 在打开后被修改，未将改变的文件导出为原版本")};ext="pdf"}
        else if kind=="html"{data=Data(("<!doctype html><html><meta charset=\"utf-8\"><title>个人研究</title><body><pre>"+htmlEscape(text)+"</pre></body></html>").utf8);ext="html"}
        else if kind=="json"{data=try JSONSerialization.data(withJSONObject:["paper":paper,"article":article,"notes":notes,"sessions":sessions,"annotations":store.annotations(id:id)],options:[.prettyPrinted,.sortedKeys]);ext="json"}
        else {data=Data(text.utf8);ext="md"}
        guard id==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，导出未写入")}
        try Task.checkCancellation()
        try requireDocumentContext(access,kinds:[.export])
        return (data:data,ext:ext,title:title)
    }
    func exportCurrent(_ payload:[String:Any],access:DetailDocumentAccess?=nil) async throws {
        try requireDocumentContext(access,kinds:[.export])
        let owner=currentPaperID,generation=contextGeneration
        let built=try await buildCurrentExport(payload,access:access)
        guard owner==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，未保存其他论文的导出")}
        try requireDocumentContext(access,kinds:[.export])
        let (data,ext,title)=built
        let panel=NSSavePanel();panel.nameFieldStringValue=String(title.prefix(70)).replacingOccurrences(of:"/",with:"-")+"."+ext
        guard try await documentPanel(panel,access:access,kinds:[.export]) == .OK,let url=panel.url else{throw DesktopOperationCancelled("已取消导出")};try Task.checkCancellation()
        guard owner==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，导出未写入")}
        try requireDocumentContext(access,kinds:[.export])
        try data.write(to:url,options:.atomic)
    }
    func backupData(access:DetailDocumentAccess?=nil) async throws {
        try requireDocumentContext(access,kinds:[.help])
        guard !terminationPending,!maintenanceBusy else{throw DesktopError.message("正在退出或整理资料，未开始备份")}
        maintenanceBusy=true;defer{maintenanceBusy=false}
        guard jobs.isEmpty else{throw DesktopError.message("请待当前任务结束再备份，保证资料和任务检查点属于同一快照")}
        let payload=try BackupCodec.collect(sourceDirectory:directory)
        let panel=NSSavePanel();panel.nameFieldStringValue="论文速递工作台-"+ISO8601DateFormatter().string(from:Date()).replacingOccurrences(of:":",with:"-")+".paperdigest"
        guard try await documentPanel(panel,access:access,kinds:[.help]) == .OK,let url=panel.url else{throw DesktopOperationCancelled("已取消备份")}
        try requireDocumentContext(access,kinds:[.help])
        try Task.checkCancellation()
        try BackupCodec.encode(payload).write(to:url,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
    }
    func restoreData(access:DetailDocumentAccess?=nil) async throws {
        try requireDocumentContext(access,kinds:[.help])
        guard !terminationPending,!maintenanceBusy else{throw DesktopError.message("正在退出或整理资料，未开始恢复")}
        maintenanceBusy=true;defer{maintenanceBusy=false}
        guard jobs.isEmpty else{throw DesktopError.message("请先结束任务再恢复资料")}
        let panel=NSOpenPanel();panel.allowsMultipleSelection=false;guard try await documentPanel(panel,access:access,kinds:[.help]) == .OK,let url=panel.url else{throw DesktopOperationCancelled("已取消恢复")}
        guard let count=try url.resourceValues(forKeys:[.fileSizeKey]).fileSize,count<=750*1024*1024 else{throw DesktopError.message("备份大小超过限制")}
        let payload=try BackupCodec.parse(Data(contentsOf:url))
        try await applyRestorePayload(payload,access:access)
    }
    func applyRestorePayload(_ payload:BackupCodec.Payload,access:DetailDocumentAccess?=nil,activeCloudJob:String?=nil) async throws {
        try requireDocumentContext(access,kinds:[.help])
        guard maintenanceBusy,jobs.keys.allSatisfy({$0==activeCloudJob}),!terminationPending else{throw DesktopError.message("请先结束任务再恢复完整资料")}
        let fm=FileManager.default,parent=directory.deletingLastPathComponent(),old=parent.appendingPathComponent("PaperDigest-before-restore-"+UUID().uuidString)
        let staged=try BackupCodec.stage(payload,parentDirectory:parent),stage=staged.stageDirectory
        defer{try? fm.removeItem(at:stage)}
        try RestoreLocalPolicy.apply(stage:stage,current:directory)
        let stagedStore=try DesktopStore(directory:stage);try validateSettings(stagedStore.value["settings"] as? [String:Any] ?? [:]);_=try LibraryService(dataDirectory:stage)
        let alert=NSAlert()
        alert.messageText="恢复个人研究空间？"
        alert.informativeText="备份文件已通过完整性校验。\n\n确认后会先保留当前研究空间，再恢复所选快照。快照之后的笔记、解析和原始用量可从恢复前副本找回。\n\n本机模型、网络和预算设置，以及已派发请求计数继续保留；API、网盘与 Zotero 许可不随备份替换。"
        let backupLocation=NSView(frame:NSRect(x:0,y:0,width:440,height:54))
        let backupCaption=NSTextField(labelWithString:"确认后保留的副本名称")
        backupCaption.frame=NSRect(x:0,y:36,width:440,height:18);backupCaption.font = .systemFont(ofSize:12);backupCaption.textColor = .secondaryLabelColor
        let backupName=NSTextField(wrappingLabelWithString:old.lastPathComponent)
        backupName.frame=NSRect(x:0,y:0,width:440,height:32);backupName.font = .monospacedSystemFont(ofSize:11,weight:.regular);backupName.textColor = .secondaryLabelColor;backupName.isSelectable=true;backupName.maximumNumberOfLines=2;backupName.toolTip=old.path
        backupLocation.addSubview(backupCaption);backupLocation.addSubview(backupName);alert.accessoryView=backupLocation
        alert.addButton(withTitle:"恢复并重新载入");alert.addButton(withTitle:"取消")
        guard try await documentConfirmation(alert,access:access,kinds:[.help]) == .alertFirstButtonReturn else{throw DesktopOperationCancelled("已取消恢复")}
        try requireDocumentContext(access,kinds:[.help])
        try Task.checkCancellation()
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
    // Structural diagnostics only: never read document text, values, href/src,
    // titles, data attributes, configuration, credentials or model material.
    static let diagnosticDOMScript = #"""
    (()=>{
      const knownIDs=new Set(["all-notes","analysis-pane","analysis-result","analyze","annotation-list","app-window","appearance","archive-connect","archive-dialog","archive-dialog-facade","archive-guide","archive-guide-detail","archive-identity","archive-note","archive-note-detail","archive-open","archive-pdf","archive-pdf-detail","archive-title","article","back","backup","check-model","choose-collection","context-label","dailyRequests","delete-key","detail-close","detail-content","detail-dialog","detail-dialog-facade","diagnostics","discard-settings","endpoint","evidence-scope","favorite","favorite-count","font","font-label","force-request","global-search","guide-frame","guide-pane","highlight-selection","httpProxy","insert-citation","key-status","library-count","library-empty","library-subtitle","library-title","library-view","maxTokens","model","model-result","model-settings","note-context","note-count","note-editor","note-pane","note-status","notes-view","outline","paper-rows","pdf-canvas","pdf-chapter","pdf-close","pdf-fit","pdf-loading","pdf-minus","pdf-name","pdf-next","pdf-original","pdf-page","pdf-page-wrap","pdf-pane","pdf-plus","pdf-prev","pdf-scroll","pdf-text-layer","pdf-toggle","pdf-total","pdf-version","pdf-zoom","protocol","question","range-from","range-to","reader-tabs","reader-view","reading-area","reading-count","reasoningEffort","reduceMotion","refresh-reader","reset-search","responsesStream","restore","result-count","reveal","save-offline","save-status","search-input","set-key","settings-button","sidebar-outline","sidebar-paper","sort","source-abstract","source-page","splitter","storage-button","storage-result","sync","sync-all","syncHours","tab-analysis","tab-guide","tab-note","task-list","tasks-view","toast","toolbar-context","zotero-dialog","zotero-dialog-facade"]);
      const tags=new Set('HTML BODY DIV MAIN ASIDE NAV SECTION ARTICLE HEADER FOOTER DIALOG FORM H1 H2 H3 H4 H5 H6 P SPAN BUTTON A INPUT TEXTAREA SELECT OPTION LABEL TABLE THEAD TBODY TR TD TH UL OL LI I SVG PATH MATH IFRAME CANVAS SCRIPT STYLE LINK META NOSCRIPT'.split(' '));
      const flag=(element,name)=>{const value=element.getAttribute(name);return value===null?'unset':value==='true'?'true':value==='false'?'false':'other';};
      const number=value=>Number.isFinite(value)?Math.round(Math.max(-10000000,Math.min(10000000,value))*100)/100:0;
      const rect=value=>({x:number(value.x),y:number(value.y),width:number(value.width),height:number(value.height)});
      const keyword=(value,allowed)=>allowed.includes(value)?value:'other';
      function element(node){
        if(!(node instanceof Element))return null;
        const style=getComputedStyle(node),rectangles=[...node.getClientRects()];
        return {tag:tags.has(node.tagName)?node.tagName:'OTHER',id:knownIDs.has(node.id)?node.id:node.id?'other':'',hidden:node.hidden===true,inert:node.inert===true,ariaHidden:flag(node,'aria-hidden'),ariaModal:flag(node,'aria-modal'),role:keyword(node.getAttribute('role'),[null,'dialog','alertdialog','tabpanel','tablist','tab','button','navigation','status']),display:keyword(style.display,['none','block','inline','inline-block','flex','inline-flex','grid','inline-grid','contents','table','table-row','table-cell','list-item','flow-root']),visibility:keyword(style.visibility,['visible','hidden','collapse']),pointerEvents:keyword(style.pointerEvents,['auto','none','all','visible','visiblePainted','visibleFill','visibleStroke','painted','fill','stroke']),bounds:rect(node.getBoundingClientRect()),clientRectsCount:Math.min(rectangles.length,1000),clientRects:rectangles.slice(0,4).map(rect)};
      }
      const surfaces=[...document.querySelectorAll('[data-dialog-surface][open]')].slice(-8);
      return {contract:'paperdigest-ui-structure-v1',documentHasFocus:document.hasFocus(),activeElement:element(document.activeElement),bodyChildren:[...document.body?.children||[]].slice(0,64).map(element),surfaces:surfaces.map(surface=>{const ancestors=[];for(let parent=surface.parentElement;parent&&ancestors.length<12;parent=parent.parentElement)ancestors.push(element(parent));return {element:element(surface),ancestors};})};
    })()
    """#
    func diagnosticNativeState(_ view:WKWebView?,window:NSWindow?)->[String:Any] {
        let responder=window?.firstResponder,respondingView=responder as? NSView
        func geometry(_ rect:NSRect)->[String:Double]{["x":rect.origin.x,"y":rect.origin.y,"width":rect.width,"height":rect.height]}
        return ["appActive":NSApp.isActive,"windowKey":window?.isKeyWindow ?? false,"firstResponderClass":responder.map{NSStringFromClass(type(of:$0))} ?? "none","firstResponderIsWebDescendant":respondingView.map{candidate in view.map{candidate === $0 || candidate.isDescendant(of:$0)} ?? false} ?? false,"firstResponderIsPDFDescendant":respondingView.map{$0 === pdfView || $0.isDescendant(of:pdfView)} ?? false,"webAttached":view?.window != nil,"webHidden":view?.isHidden ?? true,"webBounds":geometry(view?.bounds ?? .zero),"webFrame":geometry(view?.frame ?? .zero)]
    }
    // Downward observation of our own WK only. Modern public AX getters can
    // initialize lazy WebKit accessibility state; no setter/notification is used.
    // A remote proxy need not conform to the modern protocol. Report that opaque
    // boundary, rather than interpreting it as an empty WebContent AX tree.
    static func diagnosticAccessibilityStructure(_ root:AnyObject,maxNodes:Int=256,maxDepth:Int=10,maxChildren:Int=128,timeBudget:TimeInterval=0.25)->[String:Any] {
        let nodeLimit=max(1,min(256,maxNodes)),depthLimit=max(0,min(10,maxDepth)),childLimit=max(1,min(128,maxChildren)),budget=max(0,min(0.25,timeBudget))
        let roles:Set<String>=["AXApplication","AXWindow","AXSheet","AXDrawer","AXPopover","AXDialog","AXAlert","AXWebArea","AXGroup","AXScrollArea","AXSplitGroup","AXToolbar","AXTabGroup","AXRadioGroup","AXButton","AXCheckBox","AXRadioButton","AXSwitch","AXPopUpButton","AXMenuButton","AXMenu","AXMenuBar","AXMenuItem","AXTextField","AXTextArea","AXStaticText","AXHeading","AXLink","AXImage","AXTable","AXRow","AXColumn","AXCell","AXOutline","AXList","AXSlider","AXIncrementor","AXProgressIndicator","AXBusyIndicator","AXScrollBar","AXSeparator","AXUnknown"]
        let start=ProcessInfo.processInfo.systemUptime
        var queue:[(AnyObject,Int)]=[(root,0)],offset=0,seen=Set<ObjectIdentifier>(),roleCounts:[String:Int]=[:]
        var supported=0,opaque=0,repeated=0,elementCount=0,observedDepth=0,childReferences=0
        var nodesTruncated=false,depthTruncated=false,childrenTruncated=false,timeTruncated=false
        var rootElement:Any=NSNull(),rootChildCount:Any=NSNull(),rootChildrenReturned:Any=NSNull()
        while offset<queue.count {
            if ProcessInfo.processInfo.systemUptime-start>=budget {timeTruncated=true;break}
            if seen.count>=nodeLimit {nodesTruncated=true;break}
            let (object,depth)=queue[offset];offset+=1
            guard seen.insert(ObjectIdentifier(object)).inserted else{repeated+=1;continue}
            observedDepth=max(observedDepth,depth)
            guard let node=object as? any NSAccessibilityProtocol else{opaque+=1;continue}
            supported+=1
            let rawRole=node.accessibilityRole()?.rawValue,role=rawRole.map{roles.contains($0) ? $0:"other"} ?? "unset"
            roleCounts[role,default:0]+=1
            if ProcessInfo.processInfo.systemUptime-start>=budget {timeTruncated=true;break}
            let isElement=node.isAccessibilityElement();if isElement{elementCount+=1};if depth==0{rootElement=isElement}
            if ProcessInfo.processInfo.systemUptime-start>=budget {timeTruncated=true;break}
            let children=node.accessibilityChildren()
            if depth==0{rootChildrenReturned=children != nil;rootChildCount=children?.count ?? 0}
            childReferences+=children?.count ?? 0
            guard let children,!children.isEmpty else{continue}
            if depth>=depthLimit {depthTruncated=true;continue}
            if children.count>childLimit{childrenTruncated=true}
            // Bound retained objects too, not just the number of processed nodes.
            for child in children.prefix(childLimit) {
                if queue.count>=nodeLimit {nodesTruncated=true;break}
                queue.append((child as AnyObject,depth+1))
            }
        }
        return ["contract":"paperdigest-own-wk-ax-structure-v1","scope":"own-WK-public-methods-only","remoteCoverageGuaranteed":false,"opaqueBoundaryMeans":"not-readable-through-modern-protocol","samplingMayInitializeLazyAX":true,"singleGetterHardTimeout":false,"limits":["nodes":nodeLimit,"depth":depthLimit,"childrenPerNode":childLimit,"loopBudgetMilliseconds":Int(budget*1000)],"visitedNodes":seen.count,"supportedNodes":supported,"opaqueNodes":opaque,"repeatedReferences":repeated,"maximumObservedDepth":observedDepth,"observedChildReferences":childReferences,"roleCounts":roleCounts,"elementNodes":elementCount,"rootIsAccessibilityElement":rootElement,"rootChildrenReturned":rootChildrenReturned,"rootChildCount":rootChildCount,"truncated":nodesTruncated || depthTruncated || childrenTruncated || timeTruncated,"truncation":["nodes":nodesTruncated,"depth":depthTruncated,"children":childrenTruncated,"loopTime":timeTruncated]]
    }
    func diagnosticsReport() async->[String:Any] {
        let value=store?.value ?? [:],jobs=value["jobs"] as? [[String:Any]] ?? []
        let commands:Set<String>=["library.sync","library.article","library.downloadPDF","model.check","model.run","archive.materials","zotero.archive","zotero.resume","zotero.authorize","zotero.collections","zotero.status","storage.prepare","storage.openPackage","storage.cleanup","app.export","pdf.open"]
        let statuses:Set<String>=["queued","running","complete","completed","failed","cancelled","partial","pending","interrupted"]
        var report:[String:Any]=["contract":"paperdigest-diagnostics-v2","app":"论文速递工作台","version":Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "1.0.1","system":ProcessInfo.processInfo.operatingSystemVersionString,"counts":["jobs":jobs.count,"notes":(value["notes"] as? [String:Any])?.count ?? 0,"sessions":(value["sessions"] as? [Any])?.count ?? 0],"jobStates":jobs.map{row->[String:String] in let command=row["command"] as? String ?? "",status=row["status"] as? String ?? "";return ["command":commands.contains(command) ? command:"other","status":statuses.contains(status) ? status:"other"]},"credentialsIncluded":false,"personalTextIncluded":false]
        var ui:[String:Any]=[:]
        for (name,view,owner) in [("main",web,window),("settings",settingsWeb,settingsWindow)] {
            guard let view else{continue}
            var accessibility=Self.diagnosticAccessibilityStructure(view)
            // This deprecated getter remains public AppKit API. Its value is
            // separate from isAccessibilityElement, not an inferred remote state.
            accessibility["rootLegacyIsIgnored"]=view.accessibilityIsIgnored()
            var snapshot:[String:Any]=["native":diagnosticNativeState(view,window:owner),"nativeAccessibility":accessibility]
            do {if let dom=try await view.evaluateJavaScript(Self.diagnosticDOMScript) as? [String:Any]{snapshot["dom"]=dom}else{snapshot["domUnavailable"]=true}}catch{snapshot["domUnavailable"]=true}
            ui[name]=snapshot
        }
        report["uiStructure"]=ui
        return report
    }
    func diagnostics(access:DetailDocumentAccess?=nil) async throws {
        try requireDocumentContext(access,kinds:[.help])
        // Capture before showing the save panel so it cannot replace the first responder.
        let report=await diagnosticsReport()
        try Task.checkCancellation()
        try requireDocumentContext(access,kinds:[.help])
        let panel=NSSavePanel();panel.nameFieldStringValue="论文速递工作台诊断.json";guard try await documentPanel(panel,access:access,kinds:[.help]) == .OK,let url=panel.url else{throw DesktopOperationCancelled("已取消导出")};try requireDocumentContext(access,kinds:[.help]);try Task.checkCancellation();try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:url,options:.atomic)
    }
}
