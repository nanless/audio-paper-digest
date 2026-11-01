package com.nanless.paperdigest.ui
import org.junit.Assert.*
import org.junit.Test
class CachedGuideSearchMemoTest {
 @Test fun queryMemoryIsBoundedAndNeverCrossesTheNativeCacheIdentity(){val memo=CachedGuideSearchMemo();val identity=Any();for(i in 0..5)memo.put(CachedGuideMatches("q$i",setOf("p$i"),1,0),identity);assertNull(memo.get("q0",identity));assertEquals(setOf("p5"),memo.get("q5",identity)!!.paperIDs);assertNull(memo.get("q5",Any()))}
 @Test fun explicitRetryClearsOnlyThatQueryAndSuccessfulRefreshCanBeReused(){val memo=CachedGuideSearchMemo();val identity=Any();memo.put(CachedGuideMatches("retry",setOf("old"),1,0),identity);memo.put(CachedGuideMatches("other",setOf("other"),1,0),identity);memo.forget("retry");assertNull(memo.get("retry",identity));assertNotNull(memo.get("other",identity));memo.put(CachedGuideMatches("retry",setOf("new"),2,0),identity);assertEquals(setOf("new"),memo.get("retry",identity)!!.paperIDs);assertNotNull(memo.get("other",identity))}

}
