package com.nanless.paperdigest.ui
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class ResearchOrderingTest {
 @Test fun mixedMacAppendAndAndroidPrependSortByActualTimeWithoutRewriting(){val old=JSONObject().put("id","old").put("createdAt","2026-10-01T00:00:00Z");val newest=JSONObject().put("id","new").put("createdAt","2026-10-25T01:00:00Z");val middle=JSONObject().put("id","middle").put("startedAt","2026-10-20T08:00:00+08:00");val input=listOf(middle,newest,old);val before=input.map{it.toString()};assertEquals(listOf("new","middle","old"),recordsNewest(input).map{it.getString("id")});assertEquals(before,input.map{it.toString()})}
 @Test fun unknownTimesRemainStableAndDoNotBecomeFakeLatest(){val a=JSONObject().put("id","unknown-a");val b=JSONObject().put("id","unknown-b").put("createdAt","invalid");val known=JSONObject().put("id","known").put("createdAt","2026-10-20T00:00:00Z");assertEquals(listOf("known","unknown-a","unknown-b"),recordsNewest(listOf(a,b,known)).map{it.getString("id")})}
}
