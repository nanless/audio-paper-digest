package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.zotero.webdav.ZoteroDavTarget
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class CloudCredentialBorrowingTest {
    private class Fixture {
        var epoch = "workspace-one"
        var binding = CloudCredentialBinding(UUID.randomUUID().toString(), "qa@example.invalid", "PaperDigest")
        var reads = 0; var authorize: (() -> Unit)? = null; var drains = 0
        val broker = CloudCredentialBorrowing { epoch }
        val target = ZoteroDavTarget.native("users", "123", "https://dav.jianguoyun.com/dav/explicit-qa", binding.account, UUID.randomUUID().toString(), UUID.randomUUID().toString())
        init { broker.attachOwner({ binding }) { expected -> assertEquals(binding, expected); reads++; authorize?.invoke(); "Basic SYNTHETIC-NOT-PERSISTED" }; broker.attachDrain { drains++ } }
        fun grant() = broker.issue(target, binding).also{broker.publish(it,target)}
    }
    @Test fun consentUsesOwnerOnlyAndNeverPersistsCredential() { val f = Fixture(); assertEquals(0, f.reads); val grant = f.grant(); assertEquals(0, f.reads); assertEquals("Basic SYNTHETIC-NOT-PERSISTED", grant.authorization(f.target) {}); assertEquals(1, f.reads) }
    @Test fun fabricatedHandleAndAnotherAccountNeverReadOwner() { val f = Fixture(); val fake = CloudDavGrant(f.broker); assertThrows(Exception::class.java) { fake.authorization(f.target) {} }; assertThrows(Exception::class.java) { f.broker.issue(f.target, f.binding.copy(account = "other@example.invalid")) }; assertEquals(0, f.reads) }
    @Test fun exactNativeTargetAndProviderBoundBeforeRead() { val f = Fixture(); val grant = f.grant(); val other = ZoteroDavTarget.native("users", "123", "https://dav.jianguoyun.com/dav/other", f.binding.account, UUID.randomUUID().toString(), UUID.randomUUID().toString()); assertThrows(Exception::class.java) { grant.authorization(other) {} }; val foreign = ZoteroDavTarget.native("users", "123", "https://dav.example.org/dav", f.binding.account, UUID.randomUUID().toString(), UUID.randomUUID().toString()); assertThrows(Exception::class.java) { f.broker.issue(foreign, f.binding) }; assertEquals(0, f.reads) }
    @Test fun mutationInvalidatesBeforeAwaitAndSameValuesCannotReviveGrant() = runBlocking {
        val f = Fixture(); val grant = f.grant(); val mutation = f.broker.beginMutation(); assertThrows(Exception::class.java) { grant.authorization(f.target) {} }; assertEquals(0, f.reads); f.broker.drain(mutation); f.broker.requireMutation(mutation); f.broker.endMutation(mutation); assertThrows(Exception::class.java) { grant.authorization(f.target) {} }; assertEquals(1, f.drains); assertEquals(0, f.reads); f.grant().authorization(f.target) {}; assertEquals(1, f.reads)
    }
    @Test fun mutationDuringOwnerLoadCannotProduceHeader() = runBlocking {
        val f = Fixture(); val grant = f.grant(); var mutation: CloudCredentialMutation? = null; f.authorize = { mutation = f.broker.beginMutation() }; assertThrows(Exception::class.java) { grant.authorization(f.target) {} }; assertEquals(1, f.reads); f.broker.drain(mutation!!); f.broker.endMutation(mutation!!)
    }
    @Test fun workspaceAndABAAccountChangesRetireOldConsent() { val f = Fixture(); val first = f.binding; val grant = f.grant(); f.binding = first.copy(destinationID = UUID.randomUUID().toString(), account = "other@example.invalid"); assertThrows(Exception::class.java) { grant.authorization(f.target) {} }; f.binding = first.copy(destinationID = UUID.randomUUID().toString()); assertThrows(Exception::class.java) { grant.authorization(f.target) {} }; f.binding = first; f.epoch = "workspace-two"; assertThrows(Exception::class.java) { grant.authorization(f.target) {} }; assertEquals(0, f.reads) }
    @Test fun overlappingMutationsBothWaitForBorrowerDrain() = runBlocking {
        val f = Fixture(); f.grant(); val release = CompletableDeferred<Unit>(); val started = CompletableDeferred<Unit>(); val broker = CloudCredentialBorrowing { "workspace" }; var reads = 0
        broker.attachOwner({ f.binding }) { reads++; "Basic SYNTHETIC" }; broker.attachDrain { started.complete(Unit); release.await() }; broker.issue(f.target, f.binding)
        val first = broker.beginMutation(); val firstDrain = launch { broker.drain(first) }; started.await(); val second = broker.beginMutation(); val secondDrain = launch { broker.drain(second) }; yield(); assertFalse(firstDrain.isCompleted); assertFalse(secondDrain.isCompleted); assertThrows(Exception::class.java) { broker.requireMutation(second) }; release.complete(Unit); firstDrain.join(); secondDrain.join(); assertThrows(Exception::class.java) { broker.requireMutation(first) }; broker.requireMutation(second); broker.endMutation(first); broker.endMutation(second); assertEquals(0, reads)
    }
    @Test fun ownerFailureDoesNotExposeCauseOrMessage() { val f = Fixture(); f.authorize = { error("SENSITIVE-DECOY-NOT-AN-ACTUAL-SECRET") }; val e = assertThrows(Exception::class.java) { f.grant().authorization(f.target) {} }; assertFalse(e.toString().contains("SENSITIVE-DECOY")); assertNull(e.cause) }
    @Test fun copiedSelectionDataIsNotAColdProcessCapability() { val f = Fixture(); val second = CloudCredentialBorrowing { f.epoch }; var reads = 0; second.attachOwner({ f.binding }) { reads++; "Basic SYNTHETIC" }; val fake = CloudDavGrant(second); assertThrows(Exception::class.java) { fake.authorization(f.target) {} }; assertEquals(0, reads) }
    @Test fun originalUnpublishedPreviewCannotRegrantAfterSameTextPasswordSave() = runBlocking {
        val root=java.nio.file.Files.createTempDirectory("cloud-borrow-aba-").toFile().canonicalFile
        val research=java.io.File(root,"Research").apply{mkdir()};var reads=0;var drains=0;val values=mutableMapOf<String,String>()
        val secrets=object:com.nanless.paperdigest.secret.SecretStore {
            override fun load(scope:String):String?{reads++;return values[scope]}
            override fun save(scope:String,secret:String){values[scope]=secret}
            override fun remove(scope:String){values.remove(scope)}
        }
        val workspace=object:CloudWorkspace {
            override suspend fun capture(output:java.io.File):BackupCodec.Captured=error("NO_BACKUP_ALLOWED")
            override suspend fun restore(staged:BackupCodec.Staged){error("NO_RESTORE_ALLOWED")}
        }
        val broker=CloudCredentialBorrowing{"workspace-one"};broker.attachDrain{drains++}
        val cloud=CloudService(research,java.io.File(root,"Cloud"),secrets,workspace,borrowing=broker)
        cloud.save("qa@example.invalid","PaperDigest",false,24);cloud.setPassword("SYNTHETIC-NOT-A-REAL-SECRET")
        val binding=cloud.credentialBinding();val target=ZoteroDavTarget.native("users","123","https://dav.jianguoyun.com/dav/explicit-qa",binding.account,UUID.randomUUID().toString(),UUID.randomUUID().toString())
        val originalPreview=broker.issue(target,binding)
        assertEquals(0,reads)
        cloud.setPassword("SYNTHETIC-NOT-A-REAL-SECRET") // Same account/folder/password text; a different native revision.
        assertEquals(binding,cloud.credentialBinding());assertThrows(Exception::class.java){originalPreview.requireCurrent(target)}
        assertThrows(Exception::class.java){originalPreview.authorization(target){}}
        assertEquals(0,reads);assertEquals(1,drains)
        // A new explicit preview may get new consent. This never revives the original native object.
        val newPreview=broker.issue(target,binding);newPreview.requireCurrent(target)
        assertThrows(Exception::class.java){originalPreview.requireCurrent(target)};assertEquals(0,reads)
    }

    @Test fun previewCannotLoadOwnerBeforeExplicitPublishAndDismissDoesNotRevokePublishedGrant(){
        val f=Fixture();val grant=f.broker.issue(f.target,f.binding);grant.requireCurrent(f.target)
        assertThrows(Exception::class.java){grant.authorization(f.target){}};assertEquals(0,f.reads)
        f.broker.publish(grant,f.target);f.broker.discardUnpublished(grant)
        grant.authorization(f.target){};assertEquals(1,f.reads)
    }
    @Test fun retiredUnpublishedPreviewCannotPublishEvenWhenBindingTextReturns()=runBlocking{
        val f=Fixture();val original=f.broker.issue(f.target,f.binding);val token=f.broker.beginMutation();f.broker.drain(token);f.broker.endMutation(token)
        assertThrows(Exception::class.java){f.broker.publish(original,f.target)};assertThrows(Exception::class.java){original.authorization(f.target){}};assertEquals(0,f.reads)
    }

}
