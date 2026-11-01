package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.cloud.RestorePolicy
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Reads the one repository fixture also used by the Mac implementation; no copied expected results. */
class FavoriteCollectionsSharedFixtureTest {
    private fun fixture():JSONObject {
        val file=generateSequence(File(System.getProperty("user.dir")).absoluteFile){it.parentFile}
            .map { File(it,"tests/fixtures/workbench-favorite-collections-v1.json") }.firstOrNull { it.isFile }
            ?:error("Shared favorite contract fixture is missing")
        return JSONObject(file.readText())
    }
    @Test fun bothNativeValidatorsAgreeWithAllSharedValidAndInvalidDocuments(){
        val cases=fixture().getJSONArray("validationCases");assertEquals(44,cases.length())
        cases.objects().forEach { case->
            val name=case.getString("name");val personal=case.getJSONObject("personal");val expected=case.getBoolean("valid")
            assertEquals("PersonalStore: $name",expected,runCatching { PersonalStore.validate(personal.copy()) }.isSuccess)
            assertEquals("BackupCodec: $name",expected,runCatching { BackupCodec.validatePersonal(personal.copy()) }.isSuccess)
            if(expected) {
                val view=FavoriteCollections.view(personal);val details=case.getJSONObject("expected")
                if(details.has("editable"))assertEquals(name,details.getBoolean("editable"),!view.readOnly)
                details.optJSONArray("unknownTimeIDs")?.strings()?.forEach { assertNull("$name: $it",view.items[it]?.addedAt) }
                details.optJSONArray("activeIDs")?.strings()?.let { assertEquals(name,it.toSet(),personal.getJSONArray("favorites").strings().toSet());assertTrue(view.items.keys.all { id->id in it }) }
            }
        }
    }
    @Test fun sharedAtomicRejectionAndNoopCasesUseTheRealStoreAndKeepOriginalBytes(){
        val cases=fixture().getJSONArray("editCases");assertEquals(3,cases.length())
        cases.objects().forEach { case->
            val dir=Files.createTempDirectory("shared-favorite-edit-").toRealPath().toFile()
            try {
                val store=PersonalStore(dir);store.replaceValidated(case.getJSONObject("initialPersonal"));val before=File(dir,"personal.json").readBytes()
                val result=runCatching { when(case.getString("command")) {
                    "personal.favorite.edit"->store.editFavorites(case.getJSONObject("payload"))
                    "personal.list.edit"->{val p=case.getJSONObject("payload");store.editList(p.getString("key"),p.getString("action"),FavoriteCollections.paperIDs(p.getJSONArray("ids")))}
                    else->error("Unknown fixture command")
                } }
                assertEquals(case.getString("name"),case.getBoolean("expectedError"),result.isFailure)
                if(case.getBoolean("expectedUnchanged")){assertArrayEquals(case.getString("name"),before,File(dir,"personal.json").readBytes());assertEquals(canonical(case.getJSONObject("initialPersonal")),canonical(store.snapshot()))}
            }finally {dir.deleteRecursively()}
        }
    }
    @Test fun validSharedMetadataSurvivesRealBackupStageAndRestoreWithoutTimestampMigration(){
        fixture().getJSONArray("validationCases").objects().filter { it.getBoolean("valid") }.forEach { case->
            val parent=Files.createTempDirectory("shared-favorite-backup-").toRealPath().toFile()
            try {
                val incoming=File(parent,"Incoming").apply { mkdir() };val personal=case.getJSONObject("personal");val raw=personal.toString(2).toByteArray();File(incoming,"personal.json").writeBytes(raw)
                val encoded=File(parent,"backup.paperdigest");BackupCodec.capture(incoming,encoded)
                val staged=BackupCodec.stage(encoded.inputStream(),parent);assertArrayEquals(case.getString("name"),raw,File(staged.directory,"personal.json").readBytes())
                val current=File(parent,"Current").apply { mkdir() };File(current,"personal.json").writeText(PersonalStore.initial().toString())
                RestorePolicy.install(staged,current,initialize={})
                val restored=JSONObject(File(current,"personal.json").readText())
                assertEquals(case.getString("name"),canonical(personal.opt(FavoriteCollections.KEY)),canonical(restored.opt(FavoriteCollections.KEY)))
                assertEquals(canonical(personal.getJSONArray("favorites")),canonical(restored.getJSONArray("favorites")))
            }finally {parent.deleteRecursively()}
        }
    }
}
