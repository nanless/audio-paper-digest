import Foundation
import CoreFoundation
import CryptoKit

// Presentation only. Raw jobs, sessions, provider evidence and paid ledgers are never rewritten here.
enum NativeTaskFilter: String, CaseIterable { case all, active, attention
    var title: String { switch self { case .all: return "全部"; case .active: return "进行中"; case .attention: return "需处理" } }
}
enum NativeTaskAction: String, Hashable { case cancel, openSaved, openCloud, resync
    var title: String { switch self { case .cancel: return "取消"; case .openSaved: return "查看论文与保存结果"; case .openCloud: return "查看坚果云资料"; case .resync: return "重新同步" } }
}
struct NativeTaskProgress: Equatable { let completed: Int64; let total: Int64 }
struct NativeTaskRow: Equatable {
    let rowKey: String, jobID: String?, paperID: String?, command: String?, status: String?
    let title: String, subtitle: String, message: String, metadata: [String]
    let actions: [NativeTaskAction], progress: NativeTaskProgress?, running: Bool, fingerprint: String
}
struct NativeTaskInput {
    let jobs: [[String: Any]]?
    let sessions: [[String: Any]]?
    let liveJobIDs: Set<String>
}
enum NativeTaskPresentationError: Error { case recordsUnavailable, stale, invalidLayout, actionUnavailable }
struct NativeTaskSnapshot {
    let rows: [NativeTaskRow]
    func page(filter: NativeTaskFilter, requested: Int) -> NativeTaskPage {
        let visible = rows.filter { row in
            switch filter { case .all: return true; case .active: return ["running", "queued"].contains(row.status ?? ""); case .attention: return ["failed", "partial", "interrupted", "cancelled"].contains(row.status ?? "") }
        }
        let count = max(1, (visible.count + 19) / 20), page = max(0, min(requested, count - 1)), start = page * 20
        return .init(rows: Array(visible.dropFirst(start).prefix(20)), page: page, pageCount: count, total: visible.count, start: start)
    }
}
struct NativeTaskPage {
    let rows: [NativeTaskRow], page: Int, pageCount: Int, total: Int, start: Int
    var summary: String { total == 0 ? "0 条任务" : "\(total) 条任务 · \(start + 1)–\(start + rows.count) · 第 \(page + 1) / \(pageCount) 页" }
}
@MainActor enum NativeTaskProjection {
    static func integer(_ value: Any?) -> Int64? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), !(n is NSDecimalNumber) else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d >= 0, d <= 9_007_199_254_740_991, d.rounded(.towardZero) == d else { return nil }
        return Int64(d)
    }
    static func bool(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }; return n.boolValue
    }
    static func text(_ value: Any?, limit: Int = 2048) -> String? {
        guard let value = value as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value.count > limit ? String(value.prefix(limit)) + "…（界面略，原记录保留）" : value
    }
    static func identifier(_ value: Any?, empty: Bool = false) -> String? {
        guard let value = value as? String, value.utf8.count <= 2048, (value.isEmpty ? empty : !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty), !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }; return value
    }
    static func validSHA(_ value: Any?) -> String? {
        guard let value = value as? String, value.utf8.count == 64, value.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }; return value
    }
    private static let fractionalDate: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private static let simpleDate: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()
    private static let displayDate: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.timeZone = .autoupdatingCurrent; f.dateFormat = "yyyy/MM/dd HH:mm"; return f }()
    static func date(_ value: Any?) -> Date? {
        guard let value = value as? String, value.utf8.count < 64,
              value.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"#, options: .regularExpression) != nil else { return nil }
        return fractionalDate.date(from: value) ?? simpleDate.date(from: value)
    }
    static func time(_ value: Any?) -> String {
        guard let date = date(value) else { return "时间未知" }
        return displayDate.string(from: date)
    }
    static func usage(_ input: Any?) -> String {
        let usage = input as? [String: Any] ?? [:]
        func count(_ keys: [String]) -> String {
            var value: Int64?
            for key in keys where usage[key] != nil {
                guard let actual = integer(usage[key]), value == nil || value == actual else { return "未知" }
                value = actual
            }
            return value.map(String.init) ?? "未知"
        }
        return "输入\(count(["input_tokens", "prompt_tokens"])) · 输出\(count(["output_tokens", "completion_tokens"])) · 合计\(count(["total_tokens"])) tokens"
    }
    private static func purpose(_ value: Any?) -> String {
        let names = ["pdf-selection": "选区", "pdf-page": "当前物理页", "pdf-range": "指定页范围", "pdf-chapter": "原文目录章节", "pdf-full": "全文提取文字", "published-reader": "网站导读", "connection-check": "连接测试"]
        return (value as? String).flatMap { names[$0] } ?? "原材料范围未记录"
    }
    private static func modelSession(_ job: [String: Any], sessions: [[String: Any]]?) -> [String: Any]? {
        guard let id = identifier(job["id"]), let owner = identifier(job["paperID"], empty: true), let command = job["command"] as? String,
              command == "model.check" || (command == "model.run" && !owner.isEmpty), let sessions else { return nil }
        let matches = sessions.filter { ($0["id"] as? String) == id }
        guard matches.count == 1, matches[0]["paperID"] as? String == owner,
              matches[0]["kind"] as? String == (command == "model.check" ? "connection-check" : "study") else { return nil }
        return matches[0]
    }
    static func metadata(_ job: [String: Any], sessions: [[String: Any]]?) -> [String] {
        let command = job["command"] as? String ?? ""
        var lines = ["对象身份：" + (command == "library.sync" ? "全站目录" : (text(job["identity"]) ?? text(job["paperID"]) ?? "未记录"))]
        if command == "library.sync" {
            let context = [text(job["title"], limit: 512).map { "标题：" + $0 }, text(job["paperID"]).map { "论文ID：" + $0 }, text(job["identity"]).map { "身份：" + $0 }].compactMap { $0 }
            if !context.isEmpty { lines.append("原记录上下文（不代表同步范围）：" + context.joined(separator: " · ")) }
        }
        guard ["model.run", "model.check"].contains(command) else {
            let material = job["material"] as? [String: Any] ?? [:]
            if command.hasPrefix("cloud."), material["kind"] as? String == "workspace-snapshot", let created = date(material["createdAt"]), let count = integer(material["fileCount"]), count > 0, count <= 100000, let hash = validSHA(material["sha256"]) {
                _ = created
                lines.append("材料依据：完整研究空间快照 · 采集时间 \(time(material["createdAt"])) · 实际文件数 \(count) · 原编码 SHA-256 \(hash)")
            } else { lines.append("材料依据：本任务未单独记录版本或范围") }
            if command == "cloud.restore", let result = job["result"] as? [String: Any], let hash = validSHA(result["sha256"]) { lines.append("原恢复材料 SHA-256 " + hash) }
            let knownNonModel = ["library.sync", "library.article", "library.downloadPDF", "pdf.open", "archive.materials", "storage.prepare", "app.export"].contains(command) || command.hasPrefix("cloud.") || command.hasPrefix("zotero.")
            lines.append(knownNonModel ? "模型费用：本任务无需本地模型请求" : "模型费用：任务类别未识别，用量与实际金额未知"); return lines
        }
        guard let session = modelSession(job, sessions: sessions) else {
            lines.append("材料依据：" + (sessions == nil ? "研究记录读取失败，原依据未能核对" : "没有唯一匹配的原研究记录，版本与范围未知"))
            let reused = (job["result"] as? [String: Any]).flatMap { bool($0["reused"]) } == true
            lines.append(reused ? "模型费用：记录标注复用；原用量未在本任务绑定，新增派发未单独核验，实际金额未知" : "模型费用：用量与实际金额未知，不视作零费用")
            return lines
        }
        let source = session["source"] as? [String: Any] ?? [:]
        let pages = (source["pages"] as? [Any] ?? []).compactMap(integer).filter { $0 > 0 }
        var basis = [command == "model.check" ? "连接测试" : purpose(source["kind"])]
        if !pages.isEmpty { basis.append("物理页 " + pages.prefix(64).map(String.init).joined(separator: "、") + (pages.count > 64 ? "（另有页码保存在原记录）" : "")) }
        if let value = text(source["sourceVersion"], limit: 256) { basis.append("版本 " + value) }
        if let value = text(source["revision"], limit: 256) { basis.append("导读修订 " + value) }
        if let value = validSHA(source["pdfSHA"]) { basis.append("PDF SHA-256 " + value) }
        if command != "model.check", text(source["sourceVersion"]) == nil, text(source["revision"]) == nil, validSHA(source["pdfSHA"]) == nil { basis.append("原版本未记录") }
        if bool(source["truncated"]) == true { basis.append("输入已截断，不能视作全文") }
        let missing = (source["missingTextPages"] as? [Any] ?? []).compactMap(integer).filter { $0 > 0 }
        if !missing.isEmpty { basis.append("无文字页 " + missing.prefix(64).map(String.init).joined(separator: "、") + " 未分析图像") }
        if let actual = text(session["actualModel"], limit: 256) { lines.append("实际模型：" + actual) }
        else { lines.append("模型：请求 " + (text(session["model"], limit: 256) ?? "未记录") + " · 实际模型未知") }
        lines.append("材料依据：" + basis.joined(separator: " · ")); lines.append("模型费用：原记录 " + usage(session["usage"]) + " · 实际费用金额未知")
        return lines
    }
    static func make(_ input: NativeTaskInput) throws -> NativeTaskSnapshot {
        guard let jobs = input.jobs else { throw NativeTaskPresentationError.recordsUnavailable }
        var ids: [String: Int] = [:]; for job in jobs { if let id = identifier(job["id"]) { ids[id, default: 0] += 1 } }
        let names = ["cloud.check": "检查坚果云连接", "cloud.upload": "云端完整备份", "cloud.list": "读取云端备份版本", "cloud.restore": "恢复云端研究空间", "library.sync": "同步网站目录", "library.article": "读取图文导读", "library.downloadPDF": "下载原文", "pdf.open": "打开原文", "model.run": "个人解析", "model.check": "模型连接测试", "archive.materials": "准备归档材料", "zotero.archive": "存入 Zotero", "zotero.resume": "继续 Zotero 归档", "storage.prepare": "保存离线快照", "app.export": "导出研究"]
        let statuses = ["running": "进行中", "queued": "等待中", "complete": "已完成", "partial": "部分完成", "failed": "失败", "interrupted": "上次运行中断", "cancelled": "已取消"]
        let terminal = Set(["complete", "partial", "failed", "interrupted", "cancelled"])
        let sessionIndex = input.sessions.map { sessions in Dictionary(grouping: sessions, by: { ($0["id"] as? String) ?? "" }) }
        let rows = try jobs.enumerated().map { index, job -> NativeTaskRow in
            let id = identifier(job["id"]), paper = identifier(job["paperID"]), command = job["command"] as? String, status = job["status"] as? String
            let unique = id.map { ids[$0] == 1 } ?? false
            var actions: [NativeTaskAction] = []
            if unique, let id {
                if status == "running", input.liveJobIDs.contains(id) { actions = [.cancel] }
                else if let status, terminal.contains(status) {
                    if command?.hasPrefix("cloud.") == true { actions = [.openCloud] }
                    else if command == "library.sync" { actions = [.resync] }
                    else if paper != nil { actions = [.openSaved] }
                }
            }
            let details = metadata(job, sessions: sessionIndex.map { $0[id ?? ""] ?? [] })
            let rawProgress = job["progress"] as? [String: Any] ?? [:]
            let progress: NativeTaskProgress?
            if let done = integer(rawProgress["completed"]), let total = integer(rawProgress["total"]), total > 0, done <= total { progress = .init(completed: done, total: total) } else { progress = nil }
            let title = command == "library.sync" ? "同步网站目录" : (text(job["title"], limit: 512) ?? command.flatMap { names[$0] } ?? "原任务标题未记录")
            let commandTitle = command.flatMap { names[$0] } ?? text(command) ?? "任务类型未记录"
            let statusTitle = status.flatMap { statuses[$0] } ?? "原状态未识别"
            let relevant: [String: Any] = ["id": id ?? "", "paperID": paper ?? "", "command": command ?? "", "status": status ?? "", "unique": unique, "actions": actions.map(\.rawValue), "metadata": details]
            let bytes = try JSONSerialization.data(withJSONObject: relevant, options: [.sortedKeys])
            let fingerprint = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            return .init(rowKey: "\(index)|\(id ?? "unrecorded")", jobID: id, paperID: paper, command: command, status: status, title: title,
                subtitle: "\(commandTitle) · \(statusTitle) · \(time(job["startedAt"]))", message: text(job["message"]) ?? "原任务未记录说明", metadata: details,
                actions: actions, progress: progress, running: status == "running", fingerprint: fingerprint)
        }
        return .init(rows: rows)
    }
}
