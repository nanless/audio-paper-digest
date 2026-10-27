package com.nanless.paperdigest.zotero
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.update
import com.nanless.paperdigest.ui.SecretKind
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors

/** Controlled actual publication pattern, no Android Root or real key operation. */
class ZoteroCredentialProjectionTest {
    private class Keys:SecretStore {
        val entered=CountDownLatch(1);val release=CountDownLatch(1)
        override fun load(scope:String)="synthetic-old"
        override fun save(scope:String,secret:String){entered.countDown();check(release.await(5,TimeUnit.SECONDS))}
        override fun remove(scope:String)=error("not used")
    }
    private suspend fun fixture(block:suspend(ZoteroService,Keys)->Unit){val root=Files.createTempDirectory("credential-publication-").toFile().canonicalFile;val keys=Keys();try{val transport=object:ZoteroTransport{override suspend fun request(request:okhttp3.Request,limit:Int)=HttpBytes(200,emptyMap(),"{\"userID\":123,\"access\":{\"user\":{\"library\":true,\"write\":true,\"files\":true,\"notes\":true}}}".toByteArray());override suspend fun download(request:okhttp3.Request,target:File,limit:Long):HttpFile=error("no download")};val z=ZoteroService(File(root,"Research"),keys,ZoteroMaterialProvider{error("no source")},transport);z.execute("save",JSONObject().put("libraryType","users").put("libraryID","123"));z.execute("check");block(z,keys)}finally{keys.release.countDown();root.deleteRecursively()}}
    @Test fun capturedRefreshCASRetryUsesCurrentProjectionDuringPendingSave()=runBlocking{fixture{z,keys->val body=RootUpdateSecretBody(z,keys);val captured=z.state().copy();assertEquals("confirmed",captured.getString("credentialState"));val publishEntered=CountDownLatch(1);val releasePublish=CountDownLatch(1);val executor=Executors.newSingleThreadExecutor();try{var first=true;val refresh=executor.submit{body._state.update{current->if(first){first=false;publishEntered.countDown();check(releasePublish.await(5,TimeUnit.SECONDS))};current.copy(zotero=z.projectCredentialState(captured))}};assertTrue(withContext(Dispatchers.IO){publishEntered.await(3,TimeUnit.SECONDS)});val save=async{body.updateSecret(SecretKind.ZOTERO,"synthetic-new")};try{assertTrue(withContext(Dispatchers.IO){keys.entered.await(3,TimeUnit.SECONDS)});assertEquals("unknown",body._state.value.zotero.getString("credentialState"));releasePublish.countDown();withContext(Dispatchers.IO){refresh.get(3,TimeUnit.SECONDS)};assertEquals("Pending credentials must stay unknown after a concurrent pre-captured refresh publication","unknown",body._state.value.zotero.getString("credentialState"));assertEquals("unknown",z.state().getString("credentialState"))}finally{keys.release.countDown();save.join()}}finally{releasePublish.countDown();executor.shutdownNow();executor.awaitTermination(3,TimeUnit.SECONDS)}}}
    @Test fun forgedCapturedPermissionCannotOverrideCurrentUnknownOrOtherTarget()=runBlocking{fixture{z,_->val captured=z.state().copy();captured.getJSONObject("permissions").put("write",false);assertTrue(z.projectCredentialState(captured).getJSONObject("permissions").getBoolean("write"));assertEquals("unknown",z.projectCredentialState(captured.copy().put("libraryID","999")).getString("credentialState"));z.credentialsChanged();assertEquals("unknown",z.projectCredentialState(captured).getString("credentialState"));assertFalse(z.projectCredentialState(captured).has("apiKey"));assertEquals("confirmed",captured.getString("credentialState"))}}
}
