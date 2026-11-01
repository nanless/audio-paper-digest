package com.nanless.paperdigest.ui

import com.nanless.paperdigest.data.FavoriteCollections
import com.nanless.paperdigest.data.Paper
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class FavoriteLibrarySectionsTest {
    private val zone=ZoneId.of("Asia/Shanghai")
    private val today=LocalDate.of(2026,11,1)
    private fun paper(id:String)=Paper(id,id,date="2099-01-01")
    private fun view(vararg values:Pair<String,String?>)=FavoriteCollections.View(1,emptyList(),values.associate { it.first to FavoriteCollections.Item(it.second,emptySet()) },false)
    @Test fun recentSectionsUseLocalCalendarAndActualFavoriteTimeDescending(){
        val papers=listOf(paper("old"),paper("today-early"),paper("yesterday"),paper("today-late"),paper("week"))
        val view=view("old" to "2026-10-25T00:00:00Z","today-early" to "2026-10-31T16:01:00Z","today-late" to "2026-11-01T12:00:00Z","yesterday" to "2026-10-31T15:59:00Z","week" to "2026-10-26T00:00:00Z")
        val rows=favoriteLibrarySections(papers,view,false,zone,today)
        assertEquals(listOf("today","week","earlier"),rows.map { it.key })
        assertEquals(listOf("today-late","today-early"),rows[0].papers.map { it.id });assertEquals(listOf("yesterday","week"),rows[1].papers.map { it.id })
    }
    @Test fun missingAndExplicitNullTimesStayInUnknownWithoutUsingPublicationDate(){
        val rows=favoriteLibrarySections(listOf(paper("missing"),paper("null")),view("null" to null),false,zone,today)
        assertEquals(listOf("unknown"),rows.map { it.key });assertEquals(2,rows.single().papers.size);assertEquals("收藏时间未知",favoriteAddedLabel(null,zone))
    }
    @Test fun monthlyGroupingUsesLocalMonthAndUnknownIsAlwaysLast(){
        val rows=favoriteLibrarySections(listOf(paper("oct"),paper("nov"),paper("unknown")),view("oct" to "2026-10-31T15:59:00Z","nov" to "2026-10-31T16:00:00Z"),true,zone,today)
        assertEquals(listOf("2026-11","2026-10","unknown"),rows.map { it.key })
    }
    @Test fun importedFutureClockTimeIsNotMislabelledEarlier(){
        val rows=favoriteLibrarySections(listOf(paper("future")),view("future" to "2026-11-03T00:00:00Z"),false,zone,today)
        assertEquals("future",rows.single().key)
        assertEquals("future",favoriteLibrarySections(listOf(paper("future")),view("future" to "2026-11-03T00:00:00Z"),true,zone,today).single().key)
    }
    @Test fun unclassifiedAndMultipleFolderMembershipAreIndependent(){
        val view=FavoriteCollections.View(1,emptyList(),mapOf("multi" to FavoriteCollections.Item(null,setOf("a","b"))),false)
        assertTrue(favoriteMatchesFolder("multi",view,"a"));assertTrue(favoriteMatchesFolder("multi",view,"b"));assertFalse(favoriteMatchesFolder("multi",view,"unclassified"));assertTrue(favoriteMatchesFolder("legacy",view,"unclassified"))
    }
    @Test fun dateAndTimezoneChangesReclassifyTheSameMetadataAcrossDstCalendarDays(){
        val papers=listOf(paper("boundary"),paper("older"));val data=view("boundary" to "2026-10-27T04:00:00Z","older" to "2026-10-27T03:59:00Z")
        val newYork=ZoneId.of("America/New_York");val rows=favoriteLibrarySections(papers,data,false,newYork,LocalDate.of(2026,11,2))
        assertEquals(listOf("week","earlier"),rows.map {it.key});assertEquals("boundary",rows[0].papers.single().id)
        val one=listOf(paper("same"));val same=view("same" to "2026-10-31T16:01:00Z")
        assertEquals("today",favoriteLibrarySections(one,same,false,zone,today).single().key)
        assertEquals("week",favoriteLibrarySections(one,same,false,zone,today.plusDays(1)).single().key)
        assertEquals("week",favoriteLibrarySections(one,same,false,ZoneId.of("UTC"),today).single().key)
    }
}
