import Foundation

@main struct ClientProtocolsTests {
    static func main() throws {
        var checks=0
        func check(_ result:Bool,_ message:String) {
            precondition(result,message);checks+=1;print("PASS "+message)
        }
        let name="paperdigest-backup"
        let old="paperdigest-backup-v2"
        let record=try ClientProtocols.record(name,fields:["sourceDirectory":"/fixture","files":[]])
        check(record["contract"] as? String == name,"new producer uses the stable contract")
        check(ClientProtocols.hasValidHeader(record,name),"current declared schema fingerprint is validated")
        var forged=record;forged["schemaFingerprint"]=String(repeating:"0",count:64)
        check(!ClientProtocols.hasValidHeader(forged,name),"forged current schema fingerprint is rejected")
        forged=record;forged.removeValue(forKey:"schemaFingerprint")
        check(!ClientProtocols.hasValidHeader(forged,name),"missing current fingerprint is rejected")
        let legacy:[String:Any]=["contract":old,"sourceDirectory":"/fixture","files":[]]
        check(ClientProtocols.hasValidHeader(legacy,name),"the exact registered historical tag remains readable")
        check(try ClientProtocols.identityDomain(old,name)==old,"historical hash domain remains original")
        forged=legacy;forged["schemaFingerprint"]=ClientProtocols.schemaFingerprint(name)
        check(!ClientProtocols.hasValidHeader(forged,name),"historical data cannot self-upgrade with a current fingerprint")
        check(!ClientProtocols.isContract("paperdigest-backup-v999",name),"unregistered historical versions are rejected")
        check(!ClientProtocols.isContract("paperdigest-storage-aliases-v1",name),"another protocol family cannot be borrowed")
        do { _=try ClientProtocols.record(name,fields:["contract":old]);preconditionFailure("reserved field accepted") }
        catch { checks+=1;print("PASS fields cannot override the current header") }
        check(try ClientProtocols.recordKeys(old,name,fields:["files","sourceDirectory"])==["contract","files","sourceDirectory"],"historical exact field set is unchanged")
        check(try ClientProtocols.recordKeys(name,name,fields:["files","sourceDirectory"])==["contract","schemaFingerprint","files","sourceDirectory"],"current exact field set includes the verified fingerprint")
        print("Client protocol checks: \(checks)")
    }
}
