package com.nanless.paperdigest.data

import org.junit.Assert.*
import org.junit.Test

class WorkbenchNavigationTest {
    private val source=AggregateSource("a".repeat(64),"b".repeat(64),1,"index.json",0,"c".repeat(64),"foundation-sorted-keys-json-v1")
    private fun row(name:String,kind:String,date:String="2026-10-30",scope:String?=null)=PublishedAggregate(name,kind,scope,name,name,"",date,date,emptyList(),emptyList(),PublishedAggregateReader.SITE+name+"/",source)
    @Test fun officialConferenceDirectoryIsVisibleInConferenceSection() {
        val directory=row("conferences","page")
        assertTrue(workbenchAggregateInSection(directory,"conference"))
        assertFalse(workbenchAggregateInSection(directory,"page"))
        assertEquals("page",directory.kind)
    }
    @Test fun conferenceOverviewPrecedesTaskEvenWithMissingOldScope() {
        val task=row("posts/conference-interspeech-2026-task-speech-recognition","conference","2026-10-31")
        val overview=row("posts/conference-interspeech-2026","conference","2026-10-29")
        val legacyTask=row("posts/icassp2025-task-speech-enhancement","conference")
        val directory=row("conferences","page")
        assertTrue(workbenchConferenceTask(task));assertTrue(workbenchConferenceTask(legacyTask))
        assertEquals(listOf(directory,overview,task,legacyTask),workbenchAggregateOrder(listOf(task,legacyTask,overview,directory)))
    }
    @Test fun dailyPagesRemainNewestFirstAndAboutStaysSeparate() {
        val old=row("posts/2026-10-29","daily","2026-10-29")
        val fresh=row("posts/2026-10-30","daily")
        assertEquals(listOf(fresh,old),workbenchAggregateOrder(listOf(old,fresh)))
        assertTrue(workbenchAggregateInSection(row("about","page"),"page"))
        assertFalse(workbenchAggregateInSection(fresh,"conference"))
    }
}
