import Foundation
import CoreFoundation

// Optional schema-1 research metadata. Never derive an old favorite's date from
// publication/reading dates, and never let orphan metadata restore membership.
enum FavoriteCollections {
    static let maxInteger = 2_147_483_647
    static func integer(_ raw:Any?) -> Int? {
        guard let number=raw as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),number.doubleValue.isFinite,
              number.doubleValue.rounded(.towardZero)==number.doubleValue,number.doubleValue>=0,number.doubleValue<=Double(maxInteger) else{return nil}
        return number.intValue
    }
    static func validID(_ id:String)->Bool{!id.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && id.utf8.count<=256}
    static func validUUID(_ id:String)->Bool{UUID(uuidString:id)?.uuidString.lowercased()==id}
    static func normalizedName(_ name:String)throws->String{
        let value=name.trimmingCharacters(in:.whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        guard !value.isEmpty,value.utf8.count<=128,!value.unicodeScalars.contains(where:{$0.value<=0x1f || (0x7f...0x9f).contains($0.value)}) else{throw DesktopError.message("分类名称不能为空，且不能超过 128 字节")};return value
    }
    static func validTime(_ raw:Any)->Bool {
        guard let text=raw as? String,text.range(of:"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$",options:.regularExpression) != nil else{return false}
        let fields=text.prefix(19).split(whereSeparator:{!$0.isNumber}).compactMap{Int($0)}
        guard fields.count==6,fields[0]>0,fields[1]>=1,fields[1]<=12,fields[2]>=1,fields[2]<=31,fields[3]<24,fields[4]<60,fields[5]<60 else{return false}
        // ISO UTC uses the proleptic Gregorian calendar, including years before
        // 1582. Foundation's historical cutover accepts Julian-only leap dates.
        let year=fields[0],leap=year%4==0 && (year%100 != 0 || year%400==0)
        let days=[31,leap ? 29:28,31,30,31,30,31,31,30,31,30,31]
        return fields[2]<=days[fields[1]-1]
    }
    static func timestamp(_ date:Date)->String{
        let formatter=DateFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.calendar=Calendar(identifier:.gregorian);formatter.timeZone=TimeZone(secondsFromGMT:0);formatter.dateFormat="yyyy-MM-dd'T'HH:mm:ss.SSS'Z'";return formatter.string(from:date)
    }
    static func validate(_ raw:Any?)throws {
        guard let raw else{return}
        guard let object=raw as? [String:Any],let version=integer(object["version"]),version>=1 else{throw corrupt()}
        if version>1{return} // Preserve an extension written by a newer client.
        guard integer(object["revision"]) != nil,let folders=object["folders"] as? [[String:Any]],folders.count<=200,
              let items=object["items"] as? [String:[String:Any]],items.count<=100000 else{throw corrupt()}
        var folderIDs=Set<String>(),names=Set<String>()
        for folder in folders {
            guard let id=folder["id"] as? String,validUUID(id),folderIDs.insert(id).inserted,
                  let name=folder["name"] as? String,let normalized=try? normalizedName(name),normalized.utf8.elementsEqual(name.utf8),names.insert(name).inserted,
                  let date=folder["createdAt"],validTime(date) else{throw corrupt()}
        }
        for(id,item) in items {
            guard validID(id),let date=item["addedAt"],date is NSNull || validTime(date),let ids=item["folderIDs"] as? [String],
                  ids.count==Set(ids).count,ids.allSatisfy({folderIDs.contains($0)}) else{throw corrupt()}
        }
    }
    static func corrupt()->DesktopError{.message("收藏分类资料损坏，原文件已保留")}
    static func editable(_ raw:Any?)throws->[String:Any]{
        try validate(raw)
        if let object=raw as? [String:Any]{guard integer(object["version"])==1 else{throw DesktopError.message("收藏分类由更新版本创建，请升级工作台后再编辑收藏")};return object}
        return ["version":1,"revision":0,"folders":[[String:Any]](),"items":[String:[String:Any]]()]
    }
    static func changed(_ before:Any,_ after:Any)->Bool{
        (try? JSONSerialization.data(withJSONObject:before,options:.sortedKeys)) != (try? JSONSerialization.data(withJSONObject:after,options:.sortedKeys))
    }
    static func advance(_ object:inout [String:Any])throws{
        let revision=integer(object["revision"])!
        guard revision<maxInteger else{throw DesktopError.message("收藏版本已达上限，请升级工作台")};object["revision"]=revision+1
    }
    static func ids(_ raw:Any?)throws->[String]{
        guard let ids=raw as? [String],ids.count<=100000,ids.allSatisfy(validID) else{throw DesktopError.message("文献清单无效")};return Array(Set(ids)).sorted()
    }
    static func membership(_ root:[String:Any],ids:[String],now:Date)throws->[String:Any]{
        var result=root,metadata=try editable(root["favoriteCollections"]),items=metadata["items"] as! [String:[String:Any]]
        let previous=Set(root["favorites"] as? [String] ?? []),next=Set(ids)
        guard next.count<=100000,next.subtracting(previous).allSatisfy(validID) else{throw DesktopError.message("文献清单无效")}
        guard previous != next else{return root}
        for id in previous.subtracting(next){items.removeValue(forKey:id)}
        let additions=next.subtracting(previous)
        let addedAt=additions.isEmpty ? nil : timestamp(now)
        for id in additions{var item=items[id] ?? [:];item["addedAt"]=addedAt!;item["folderIDs"]=[String]();items[id]=item}
        guard items.count<=100000 else{throw DesktopError.message("收藏记录已达 100000 条上限")}
        metadata["items"]=items;try advance(&metadata);result["favorites"]=next.sorted();result["favoriteCollections"]=metadata;return result
    }
    static func edit(_ root:[String:Any],payload:[String:Any],now:Date)throws->[String:Any]{
        var metadata=try editable(root["favoriteCollections"])
        guard let expected=integer(payload["expectedRevision"]),expected==integer(metadata["revision"]) else{throw DesktopError.message("收藏分类已在其他视图更新，请重新载入；当前选择仍保留")}
        let original=metadata
        var folders=metadata["folders"] as! [[String:Any]],items=metadata["items"] as! [String:[String:Any]],favorites=Set(root["favorites"] as? [String] ?? [])
        let action=payload["action"] as? String ?? ""
        switch action {
        case "folder.create","folder.rename":
            let name=try normalizedName(payload["name"] as? String ?? ""),id=payload["folderID"] as? String ?? ""
            guard !folders.contains(where:{$0["name"] as? String==name && (action=="folder.create" || $0["id"] as? String != id)}) else{throw DesktopError.message("已有同名分类，请换一个名称")}
            if action=="folder.create" {guard folders.count<200 else{throw DesktopError.message("最多创建 200 个收藏分类")};folders.append(["id":UUID().uuidString.lowercased(),"name":name,"createdAt":timestamp(now)])}
            else{guard let index=folders.firstIndex(where:{$0["id"] as? String==id}) else{throw DesktopError.message("收藏分类已不存在，请重新载入")};folders[index]["name"]=name}
        case "folder.delete":
            guard let id=payload["folderID"] as? String,validUUID(id) else{throw DesktopError.message("收藏分类身份无效")}
            folders.removeAll{$0["id"] as? String==id}
            for(key,var item) in items{item["folderIDs"]=(item["folderIDs"] as! [String]).filter{$0 != id};items[key]=item}
        case "items.assign":
            let selected=try ids(payload["ids"]),requested=try ids(payload["folderIDs"]),known=Set(folders.compactMap{$0["id"] as? String})
            guard requested.allSatisfy({known.contains($0)}),let mode=payload["mode"] as? String,["add","remove","replace"].contains(mode) else{throw DesktopError.message("收藏分类选择无效，请重新载入")}
            if let flag=payload["addMissing"],CFGetTypeID(flag as CFTypeRef) != CFBooleanGetTypeID(){throw DesktopError.message("收藏并归类选项无效")}
            guard payload["addMissing"] as? Bool==true || selected.allSatisfy({favorites.contains($0)}) else{throw DesktopError.message("所选论文尚未全部收藏，请明确选择“收藏并归类”") }
            let addedAt=selected.contains(where:{!favorites.contains($0)}) ? timestamp(now):nil
            for id in selected {
                if !favorites.contains(id){guard payload["addMissing"] as? Bool==true else{continue};favorites.insert(id);var item=items[id] ?? [:];item["addedAt"]=addedAt!;item["folderIDs"]=[String]();items[id]=item}
                var item=items[id] ?? ["addedAt":NSNull(),"folderIDs":[String]()]
                let before=Set(item["folderIDs"] as! [String]),target=Set(requested)
                let after=mode=="replace" ? target : mode=="add" ? before.union(target) : before.subtracting(target)
                if before != after{item["folderIDs"]=after.sorted();items[id]=item}
            }
            guard favorites.count<=100000,items.count<=100000 else{throw DesktopError.message("收藏记录已达 100000 条上限")}
        default:throw DesktopError.message("收藏分类操作无效")
        }
        metadata["folders"]=folders;metadata["items"]=items
        guard changed(original,metadata) || favorites != Set(root["favorites"] as? [String] ?? []) else{return root}
        try advance(&metadata);var result=root;result["favoriteCollections"]=metadata;result["favorites"]=favorites.sorted();return result
    }
}
