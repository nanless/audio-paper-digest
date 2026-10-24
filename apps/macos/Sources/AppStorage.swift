import AppKit
import WebKit

extension PaperDigestApp {
    func prepareOffline(progress:@escaping @Sendable([String:Any])->Void) async throws->[String:Any] {
        let owner=currentPaperID,generation=contextGeneration,paper=currentPaper
        guard !owner.isEmpty,!owner.hasPrefix("local:"),currentArticle["offlineMode"] as? Bool != true else{throw DesktopError.message("请选择网站当前论文；已有离线快照可直接在本机资料中打开")}
        let article=try await library.handle(command:"library.article",payload:["paperID":owner],progress:progress)
        try verifyArticleBinding(article,paper:paper)
        try Task.checkCancellation()
        guard owner==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，未保存其他论文的离线包")}
        let pdf=try await library.handle(command:"library.downloadPDF",payload:["paperID":owner],progress:progress)
        try verifyPDFBinding(pdf,paper:paper,article:article)
        guard pdf["isStale"] as? Bool != true else{throw DesktopError.message("原文当前性复验失败，旧 PDF 仍可阅读，未与新导读混装离线包")}
        try Task.checkCancellation()
        guard owner==currentPaperID,generation==contextGeneration else{throw DesktopError.message("论文已切换，原资料缓存保留，请重新选择后保存")}
        progress(["phase":"sealing","message":"正在核验图文、原文与来源版本","completed":0,"total":0])
        let result=try await storage.register(paper:paper,article:article,pdf:pdf)
        emit("storage.changed");return result
    }
    func openOffline(_ payload:[String:Any],beforeInstall:(([String:Any]) async throws ->Void)?=nil,afterInstall:(()->Void)?=nil) async throws->[String:Any] {
        if beforeInstall==nil {try requireMainContextAvailable()}
        let generation=contextGeneration
        guard let identifier=payload["id"] as? String else{throw DesktopError.message("请选择真实离线包")}
        try await flushEdits()
        guard generation==contextGeneration,!terminationPending,!maintenanceBusy else{throw DesktopError.message("阅读上下文已变化，请重新打开离线资料")}
        let result=try await storage.openPackage(id:identifier)
        guard generation==contextGeneration,!terminationPending,!maintenanceBusy,let paper=result["paper"] as? [String:Any],let article=result["article"] as? [String:Any],let id=paper["id"] as? String else{throw DesktopError.message("阅读上下文已变化，离线包未安装")}
        try Task.checkCancellation()
        if beforeInstall==nil {try requireMainContextAvailable()}
        // Prepare the only fallible persistence before changing the main WK.
        // Remembering a verified package is not a current-reader transition.
        try store.rememberPaper(paper)
        if let beforeInstall {try await beforeInstall(result)}
        try Task.checkCancellation()
        guard generation==contextGeneration,!terminationPending,!maintenanceBusy else{throw DesktopError.message("阅读上下文已变化，离线包未安装")}
        if beforeInstall==nil {try requireMainContextAvailable()}
        contextGeneration+=1;currentPaper=paper;currentPaperID=id;currentArticle=article;offlinePDF=result["pdf"] as? [String:Any]
        pdfView.document=nil;pdfView.isHidden=true;currentPDFSHA="";currentPDFPath=nil;pdfOwner="";pdfVersion="";currentPDFReceipt=[:];pendingPDFPage=nil;selectionSource=[:];annotationsByID=[:]
        // No await between the final CAS, native source installation and close.
        afterInstall?();emit("paper.changed");return result
    }
    func cleanupStorage(_ payload:[String:Any]) async throws->[String:Any] {
        guard jobs.isEmpty,!maintenanceBusy else{throw DesktopError.message("请先等待任务结束，再检查未引用缓存")}
        try await flushEdits()
        guard jobs.isEmpty,!terminationPending,!maintenanceBusy else{throw DesktopError.message("保存期间任务状态变化，请重新检查")}
        maintenanceBusy=true;defer{maintenanceBusy=false}
        guard let plan=payload["planID"] as? String else{throw DesktopError.message("请先生成真实清理计划")}
        let alert=NSAlert();alert.messageText="将未引用的缓存移到废纸篓？";alert.informativeText="确认后会重新核验文件和引用。个人笔记、PDF 原文、离线包、模型响应和 Zotero 检查点均保留。可在 Finder 的废纸篓中恢复。";alert.addButton(withTitle:"移到废纸篓");alert.addButton(withTitle:"取消")
        guard await confirmStorageCleanup(alert) == .alertFirstButtonReturn else{throw DesktopOperationCancelled("已取消整理")}
        let checked=try await storage.validateCleanupPlan(planID:plan)
        let rows=checked["files"] as? [[String:Any]] ?? []
        let files=rows.compactMap{$0["filePath"] as? String}.map{URL(fileURLWithPath:$0)}
        guard files.count==rows.count else{throw DesktopError.message("清理计划格式变化，未移动文件")}
        if !files.isEmpty {
            try await withCheckedThrowingContinuation{(continuation:CheckedContinuation<Void,Error>) in
                NSWorkspace.shared.recycle(files){_,error in if let error{continuation.resume(throwing:error)}else{continuation.resume()}}
            }
        }
        emit("storage.changed");return ["movedToTrash":files.count,"logicalBytes":checked["bytes"] ?? 0]
    }
}
