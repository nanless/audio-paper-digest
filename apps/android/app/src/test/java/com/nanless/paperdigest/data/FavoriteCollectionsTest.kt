package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch

class FavoriteCollectionsTest {
    private val folder="00000000-0000-4000-8000-000000000001"
    private val other="00000000-0000-4000-8000-000000000002"
    private fun store()=PersonalStore(Files.createTempDirectory("favorite-contract-").toRealPath().toFile())
    private fun metadata()=JSONObject().put("version",1).put("revision",0).put("folders",JSONArray()).put("items",JSONObject())
    private fun folderObject(id:String=folder,name:String="音频",at:String="2026-11-01T00:00:00Z")=JSONObject().put("id",id).put("name",name).put("createdAt",at)
    private fun item(at:Any=JSONObject.NULL,folders:List<String> = emptyList())=JSONObject().put("addedAt",at).put("folderIDs",JSONArray(folders))
    private fun create(store:PersonalStore,name:String="音频"):String=store.editFavorites(JSONObject().put("action","folder.create").put("expectedRevision",revision(store)).put("name",name)).getString("folderID")
    private fun revision(store:PersonalStore)=store.snapshot().optJSONObject(FavoriteCollections.KEY)?.optInt("revision",0)?:0
    private fun assign(store:PersonalStore,ids:List<String>,folders:List<String>,mode:String="add",addMissing:Boolean=false,expected:Int=revision(store))=
        store.editFavorites(JSONObject().put("action","items.assign").put("expectedRevision",expected).put("ids",JSONArray(ids)).put("folderIDs",JSONArray(folders)).put("mode",mode).put("addMissing",addMissing))
    private fun validateBoth(personal:JSONObject){PersonalStore.validate(personal);BackupCodec.validatePersonal(personal)}
    private fun invalidBoth(personal:JSONObject){assertThrows(Exception::class.java){PersonalStore.validate(personal)};assertThrows(Exception::class.java){BackupCodec.validatePersonal(personal)}}

    @Test fun existingSharedRootKeepsReleasedFormatAndNewRootUsesStableFormat() {
        val store=store()
        val protocols=com.nanless.paperdigest.protocols.ClientProtocols
        val family="paperdigest-personal-library"
        val collections="paperdigest-favorite-collections"
        val fresh=store.snapshot()
        assertTrue(protocols.isCurrentHeader(fresh,family))
        assertFalse(fresh.has("schema"))
        FavoriteCollections.replaceList(fresh,"favorites",listOf("stable"))
        assertTrue(protocols.isCurrentHeader(fresh.getJSONObject(FavoriteCollections.KEY),collections))
        BackupCodec.validatePersonal(fresh)
        val old=PersonalStore.initial().apply{remove("contract");remove("schemaFingerprint");put("schema",1)}
        invalidBoth(JSONObject(old.toString()).put(FavoriteCollections.KEY,fresh.getJSONObject(FavoriteCollections.KEY)))
        store.replaceValidated(old)
        val edited=store.snapshot()
        FavoriteCollections.replaceList(edited,"favorites",listOf("existing"))
        store.replaceValidated(edited)
        val cold=PersonalStore(store.directory).snapshot()
        assertEquals(1,cold.getInt("schema"))
        assertFalse(cold.has("contract"))
        assertEquals(1,cold.getJSONObject(FavoriteCollections.KEY).getInt("version"))
        assertFalse(cold.getJSONObject(FavoriteCollections.KEY).has("schemaFingerprint"))
        BackupCodec.validatePersonal(cold)
        invalidBoth(cold.put("contract",family).put("schemaFingerprint",protocols.schemaFingerprint(family)))
    }
    @Test fun oldFavoritesAreUnknownWithoutRewritingTheirFileOnRead(){
        val store=store();val original=store.snapshot().put("favorites",JSONArray(listOf("old")));store.replaceValidated(original)
        val bytes=File(store.directory,"personal.json").readBytes();val restored=PersonalStore(store.directory)
        assertNull(FavoriteCollections.view(restored.snapshot()).items["old"])
        assertFalse(restored.snapshot().has(FavoriteCollections.KEY));assertArrayEquals(bytes,File(store.directory,"personal.json").readBytes())
        restored.editList("favorites","add",listOf("old"));assertFalse(restored.snapshot().has(FavoriteCollections.KEY))
    }
    @Test fun actualNewAddsGetMillisecondsButDuplicateAddsAndClassificationKeepTheTime(){
        val store=store();store.editList("favorites","add",listOf("p"));val at=FavoriteCollections.view(store.snapshot()).items.getValue("p").addedAt!!
        assertTrue(at.matches(Regex(".*\\.[0-9]{3}Z")));FavoriteCollections.instant(at)
        val firstRevision=revision(store);store.editList("favorites","add",listOf("p"));assertEquals(firstRevision,revision(store))
        val id=create(store);assign(store,listOf("p"),listOf(id));assertEquals(at,FavoriteCollections.view(store.snapshot()).items.getValue("p").addedAt)
        val after=revision(store);assign(store,listOf("p"),listOf(id));assertEquals(after,revision(store))
    }
    @Test fun oldUnknownFavoriteAssignedToFolderStaysUnknownAndUnknownFieldsSurvive(){
        val store=store();store.replaceValidated(store.snapshot().put("favorites",JSONArray(listOf("old"))).put("futureRoot",JSONObject().put("keep",true)))
        val id=create(store);assign(store,listOf("old"),listOf(id));val view=FavoriteCollections.view(store.snapshot());assertNull(view.items.getValue("old").addedAt)
        assertTrue(store.snapshot().getJSONObject("futureRoot").getBoolean("keep"))
    }
    @Test fun orphanMetadataNeverRevivesAndReaddDoesNotReuseOldTimeOrFolders(){
        val meta=metadata().put("folders",JSONArray().put(folderObject()));meta.getJSONObject("items").put("orphan",item("2000-01-01T00:00:00Z",listOf(folder)).put("futureItem","preserved"));meta.put("futureMeta",42)
        val store=store();store.replaceValidated(store.snapshot().put(FavoriteCollections.KEY,meta));assertTrue(FavoriteCollections.view(store.snapshot()).items.isEmpty())
        store.editList("favorites","add",listOf("orphan"));val raw=store.snapshot().getJSONObject(FavoriteCollections.KEY);val entry=raw.getJSONObject("items").getJSONObject("orphan")
        assertNotEquals("2000-01-01T00:00:00Z",entry.getString("addedAt"));assertEquals(0,entry.getJSONArray("folderIDs").length());assertEquals("preserved",entry.getString("futureItem"));assertEquals(42,raw.getInt("futureMeta"))
    }
    @Test fun classificationRequiresExplicitAddMissingAndExpectedRevision(){
        val store=store();val id=create(store);val before=File(store.directory,"personal.json").readBytes()
        assertThrows(IllegalArgumentException::class.java){assign(store,listOf("not-favorite"),listOf(id))};assertArrayEquals(before,File(store.directory,"personal.json").readBytes())
        assign(store,listOf("new"),listOf(id),addMissing=true);assertEquals(listOf("new"),store.list("favorites"));assertNotNull(FavoriteCollections.view(store.snapshot()).items.getValue("new").addedAt)
        assertThrows(AppFailure::class.java){assign(store,listOf("new"),emptyList(),expected=0)}
        assertThrows(IllegalArgumentException::class.java){store.editFavorites(JSONObject().put("action","folder.create").put("name","缺少修订"))}
    }
    @Test fun folderRenameNfcUniquenessAndDeleteOnlyRemoveReferences(){
        val store=store();val first=create(store,"  Cafe\u0301  ");assertEquals("Café",FavoriteCollections.view(store.snapshot()).folders.single().name)
        assertThrows(IllegalArgumentException::class.java){create(store,"Café")}
        val second=create(store,"CAFÉ");assign(store,listOf("p"),listOf(first,second),addMissing=true)
        val rev=revision(store);store.editFavorites(JSONObject().put("action","folder.rename").put("folderID",first).put("name","Café").put("expectedRevision",rev));assertEquals(rev,revision(store))
        store.editFavorites(JSONObject().put("action","folder.delete").put("folderID",first).put("expectedRevision",rev))
        assertEquals(listOf("p"),store.list("favorites"));assertEquals(setOf(second),FavoriteCollections.view(store.snapshot()).items.getValue("p").folderIDs)
        val deletedRevision=revision(store);val result=store.editFavorites(JSONObject().put("action","folder.delete").put("folderID",first).put("expectedRevision",deletedRevision));assertFalse(result.getBoolean("changed"));assertEquals(deletedRevision,revision(store))
    }
    @Test fun assignmentAddRemoveAndReplaceHaveDistinctMultiCategoryBehavior(){
        val store=store();val a=create(store,"一");val b=create(store,"二");assign(store,listOf("p"),listOf(a),addMissing=true);assign(store,listOf("p"),listOf(b))
        assertEquals(setOf(a,b),FavoriteCollections.view(store.snapshot()).items.getValue("p").folderIDs)
        assign(store,listOf("p"),listOf(a),"remove");assertEquals(setOf(b),FavoriteCollections.view(store.snapshot()).items.getValue("p").folderIDs)
        assign(store,listOf("p"),listOf(a),"replace");assertEquals(setOf(a),FavoriteCollections.view(store.snapshot()).items.getValue("p").folderIDs)
    }
    @Test fun explicitAtomicListEditsDoNotLoseOtherConcurrentPapers(){
        val store=store();val gate=CountDownLatch(1);val threads=(1..20).map { index->Thread { gate.await();store.editList("favorites","add",listOf("p-$index")) }.also { it.start() } }
        gate.countDown();threads.forEach(Thread::join);assertEquals(20,store.list("favorites").size);assertEquals(20,revision(store))
        val at=FavoriteCollections.view(store.snapshot()).items.getValue("p-1").addedAt
        store.editList("favorites","remove",listOf("p-2"));assertFalse("p-2" in store.list("favorites"));assertEquals(at,FavoriteCollections.view(store.snapshot()).items.getValue("p-1").addedAt)
    }
    @Test fun legacySetListDiffPreservesTimesAndNotesDoNotAdvanceFavoriteRevision(){
        val store=store();store.setList("favorites",listOf("a","b"));val original=FavoriteCollections.view(store.snapshot()).items.getValue("a").addedAt
        store.setList("favorites",listOf("a","c"));assertEquals(original,FavoriteCollections.view(store.snapshot()).items.getValue("a").addedAt);assertFalse(store.snapshot().getJSONObject(FavoriteCollections.KEY).getJSONObject("items").has("b"))
        val rev=revision(store);store.saveNote("a","unchanged favorite time",0);store.editList("reading","add",listOf("x"));assertEquals(rev,revision(store))
    }
    @Test fun unknownFutureVersionIsPreservedWhileFlatFavoritesStayReadableAndOtherEditsWork(){
        val store=store();val future=JSONObject().put("version",2).put("opaque",JSONArray(listOf("raw",42)))
        store.replaceValidated(store.snapshot().put("favorites",JSONArray(listOf("old"))).put(FavoriteCollections.KEY,future));assertTrue(FavoriteCollections.view(store.snapshot()).readOnly)
        store.saveNote("old","allowed",0);store.editList("reading","add",listOf("old"));assertEquals(canonical(future),canonical(store.snapshot().getJSONObject(FavoriteCollections.KEY)))
        assertThrows(AppFailure::class.java){store.editList("favorites","add",listOf("new"))};assertThrows(AppFailure::class.java){create(store)};validateBoth(store.snapshot())
    }
    @Test fun saveFailureRollsBackMembershipMetadataAndRevisionTogether(){
        val store=store();store.editList("favorites","add",listOf("old"));val before=canonical(store.snapshot());val path=File(store.directory,"personal.json").toPath();val outside=Files.createTempFile("favorite-original-",".json");Files.copy(path,outside,java.nio.file.StandardCopyOption.REPLACE_EXISTING);Files.delete(path);Files.createSymbolicLink(path,outside)
        val bytes=Files.readAllBytes(outside);assertThrows(IllegalArgumentException::class.java){store.editList("favorites","add",listOf("new"))};assertEquals(before,canonical(store.snapshot()));assertArrayEquals(bytes,Files.readAllBytes(outside))
    }
    @Test fun nativeAndMetadataPaperIDsUseUtf8BytesWithoutTighteningOldFlatArrays(){
        val short="文".repeat(85);val long="文".repeat(86);val store=store()
        store.editList("favorites","add",listOf(short));assertTrue(short in store.list("favorites"))
        val before=canonical(store.snapshot());assertThrows(IllegalArgumentException::class.java){store.editList("favorites","add",listOf(long))};assertEquals(before,canonical(store.snapshot()))
        validateBoth(PersonalStore.initial().put("favorites",JSONArray(listOf(long))))
        invalidBoth(PersonalStore.initial().put(FavoriteCollections.KEY,metadata().put("items",JSONObject().put(long,item()))))
        val old=store();old.replaceValidated(old.snapshot().put("favorites",JSONArray(listOf("",long,"old"))));old.editList("favorites","add",listOf("new"));assertEquals(setOf("",long,"old","new"),old.list("favorites").toSet());old.saveNote("old","other edits remain possible",0)
        val repeated=JSONArray(List(100_001){"new"});assertThrows(IllegalArgumentException::class.java){old.editFavorites(JSONObject().put("action","items.assign").put("expectedRevision",revision(old)).put("ids",repeated).put("folderIDs",JSONArray()).put("mode","add"))}
    }
    @Test fun bothValidatorsRejectFractionalRevisionBadDatesDanglingFoldersAndDuplicateNames(){
        val changes=listOf<(JSONObject)->Unit>(
            {it.put("revision",1.5)}, {it.put("revision","1")}, {it.put("version",true)},
            {it.put("folders",JSONArray().put(folderObject(at="0000-01-01T00:00:00Z")))},
            {it.put("folders",JSONArray().put(folderObject(at="2026-02-30T00:00:00Z")))},
            {it.put("folders",JSONArray().put(folderObject(at="2025-02-29T00:00:00Z")))},
            {it.put("folders",JSONArray().put(folderObject(at="2026-11-01T00:00:60Z")))},
            {it.put("folders",JSONArray().put(folderObject(at="2026-11-01T24:00:00Z")))},
            {it.put("folders",JSONArray().put(folderObject(at="2026-11-01T00:00:00+00:00")))},
            {it.put("folders",JSONArray().put(folderObject()).put(folderObject(other)))},
            {it.put("folders",JSONArray().put(folderObject(name=" e\u0301 ")))},
            {it.put("folders",JSONArray().put(folderObject(name="含\u0000控制字")))},
            {it.put("folders",JSONArray().put(folderObject(name="含\u0085控制字")))},
            {it.getJSONObject("items").put("p",item(folders=listOf(folder)))},
            {it.put("folders",JSONArray().put(folderObject()));it.getJSONObject("items").put("p",item(folders=listOf(folder,folder)))},
            {it.getJSONObject("items").put("p",JSONObject().put("folderIDs",JSONArray()))}
        )
        changes.forEach { change->val meta=metadata();change(meta);invalidBoth(PersonalStore.initial().put(FavoriteCollections.KEY,meta)) }
        for(at in listOf("2024-02-29T00:00:00Z","2026-11-01T00:00:00.123456789Z"))validateBoth(PersonalStore.initial().put(FavoriteCollections.KEY,metadata().put("folders",JSONArray().put(folderObject(at=at)))))
    }
}
