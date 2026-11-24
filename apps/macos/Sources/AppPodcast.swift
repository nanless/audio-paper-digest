import Foundation
import CoreFoundation

@MainActor extension PaperDigestApp {
    func configurePodcastService() {
        let cacheRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.nanless.PaperDigest/PodcastCache", isDirectory: true)
        guard let service = try? PodcastPlayerService(cacheDirectory: cacheRoot) else { return }
        self.podcast = service
        let proxy = store?.setting("httpProxy") as? String
        Task { [weak self] in
            guard let app = self else { return }
            await service.configureProxy(proxy)
            await service.setStateObserver { [weak app] snapshot in
                Task { @MainActor in
                    app?.emit("podcast.state", snapshot)
                }
            }
        }
    }

    func updatePodcastProxy(_ proxy: String?) async {
        await podcast?.configureProxy(proxy)
    }

    func cleanupPodcastForTermination() async {
        await podcast?.shutdown()
    }

    func dispatchPodcast(_ command: String, payload: [String: Any]) async throws -> [String: Any] {
        guard let service = podcast else {
            throw DesktopError.message("音频播客服务尚未初始化")
        }
        switch command {
        case "podcast.feed":
            let force = payload["refresh"] as? Bool ?? false
            return try await service.fetchFeed(forceRefresh: force)
        case "podcast.state":
            return await service.stateSnapshot()
        case "podcast.play":
            let episodeId: String?
            if let raw = payload["episodeId"], !(raw is NSNull) {
                guard let s = raw as? String else {
                    throw DesktopError.message("播客节目编号无效")
                }
                episodeId = s.isEmpty ? nil : s
            } else {
                episodeId = nil
            }
            let startSeconds: Double?
            if let rawStart = payload["startSeconds"], !(rawStart is NSNull) {
                guard let num = rawStart as? NSNumber,
                      CFGetTypeID(num) != CFBooleanGetTypeID(),
                      num.doubleValue.isFinite, num.doubleValue >= 0 else {
                    throw DesktopError.message("播客起始播放时间无效")
                }
                startSeconds = num.doubleValue
            } else {
                startSeconds = nil
            }
            return try await service.play(episodeId: episodeId, startSeconds: startSeconds)
        case "podcast.pause":
            return await service.pause()
        case "podcast.stop":
            return await service.stop()
        case "podcast.seek":
            guard let num = payload["seconds"] as? NSNumber,
                  CFGetTypeID(num) != CFBooleanGetTypeID(),
                  num.doubleValue.isFinite, num.doubleValue >= 0 else {
                throw DesktopError.message("播客跳转位置无效")
            }
            return try await service.seek(seconds: num.doubleValue)
        case "podcast.rate":
            guard let num = payload["rate"] as? NSNumber,
                  CFGetTypeID(num) != CFBooleanGetTypeID(),
                  num.doubleValue.isFinite else {
                throw DesktopError.message("播客倍速参数无效")
            }
            return try await service.setRate(num.doubleValue)
        case "podcast.download":
            guard let episodeId = payload["episodeId"] as? String, !episodeId.isEmpty else {
                throw DesktopError.message("缺少要下载的播客节目编号")
            }
            _ = try await service.downloadEpisode(id: episodeId)
            return await service.stateSnapshot()
        case "podcast.clearCache":
            return await service.clearCache()
        default:
            throw DesktopError.message("不支持的播客操作：\(command)")
        }
    }
}
