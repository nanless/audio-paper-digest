package com.nanless.paperdigest.zotero
import org.junit.Assert.*
import org.junit.Test
class ZoteroCredentialLeaseTest {
    private fun rejects(body:()->Unit){try{body()}catch(_:ZoteroCredentialSuperseded){return};throw AssertionError("Expected stale credential refusal")}
    @Test fun retiredRevisionCannotConfirmOrReappearAfterABA(){val gate=ZoteroCredentialLease();val old=gate.capture();gate.confirm(old,"target-a","then");assertEquals("then",gate.confirmedAt("target-a"));gate.changed();gate.changed();rejects{gate.confirm(old,"target-a","late")};assertNull(gate.confirmedAt("target-a"));val fresh=gate.capture();gate.confirm(fresh,"target-a","now");assertEquals("now",gate.confirmedAt("target-a"));assertNull(gate.confirmedAt("target-b"))}
    @Test fun overlappingMutationsCannotReopenWhenOnlyFirstFinishes(){val gate=ZoteroCredentialLease();val old=gate.capture();val first=gate.beginMutation();val second=gate.beginMutation();gate.endMutation(first);rejects{gate.capture()};rejects{gate.requireCurrent(old)};gate.endMutation(second);gate.confirm(gate.capture(),"target","fresh");assertEquals("fresh",gate.confirmedAt("target"))}
    @Test fun failedOrCancelledMutationNeverRestoresPriorConfirmation(){val gate=ZoteroCredentialLease();val old=gate.capture();gate.confirm(old,"target","old");val mutation=gate.beginMutation();try{throw IllegalStateException("synthetic")}catch(_:IllegalStateException){}finally{gate.endMutation(mutation)};assertNull(gate.confirmedAt("target"));rejects{gate.confirm(old,"target","late")}}
    @Test fun foreignMutationCannotFinishARealPendingMutation(){val gate=ZoteroCredentialLease();val pending=gate.beginMutation();try{gate.endMutation(ZoteroCredentialMutation());fail("foreign owner ended gate")}catch(_:IllegalStateException){};rejects{gate.capture()};gate.endMutation(pending);gate.capture()}
}
