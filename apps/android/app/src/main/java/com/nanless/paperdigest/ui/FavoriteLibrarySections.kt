package com.nanless.paperdigest.ui

import com.nanless.paperdigest.data.FavoriteCollections
import com.nanless.paperdigest.data.Paper
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

internal data class FavoriteLibrarySection(val key:String,val label:String,val papers:List<Paper>)
/** Display projection only: publication dates never stand in for an unknown favorite timestamp. */
internal fun favoriteLibrarySections(papers:List<Paper>,view:FavoriteCollections.View,monthly:Boolean,
    zone:ZoneId=ZoneId.systemDefault(),today:LocalDate=LocalDate.now(zone)):List<FavoriteLibrarySection> {
    val times=papers.mapNotNull { paper->view.items[paper.id]?.addedAt?.let { paper.id to FavoriteCollections.instant(it) } }.toMap()
    val known=papers.filter { it.id in times }.sortedWith(compareByDescending<Paper> { times.getValue(it.id) }.thenBy { it.id })
    val groups=linkedMapOf<String,MutableList<Paper>>()
    for(paper in known) {
        val date=times.getValue(paper.id).atZone(zone).toLocalDate()
        val key=when {
            date.isAfter(today)->"future"
            monthly->date.toString().take(7)
            date==today->"today"
            !date.isBefore(today.minusDays(6))->"week"
            else->"earlier"
        }
        groups.getOrPut(key){mutableListOf()}.add(paper)
    }
    val result=groups.map { (key,rows)->FavoriteLibrarySection(key,when(key){"today"->"今天收藏";"week"->"近 7 天收藏";"earlier"->"更早收藏";"future"->"较晚日期（请检查设备时间）";else->"${key.take(4)} 年 ${key.takeLast(2).toInt()} 月收藏"},rows) }.toMutableList()
    val unknown=papers.filter { it.id !in times }
    if(unknown.isNotEmpty())result+=FavoriteLibrarySection("unknown","收藏时间未知",unknown)
    return result
}

internal fun favoriteAddedLabel(addedAt:String?,zone:ZoneId=ZoneId.systemDefault()):String =
    if(addedAt==null)"收藏时间未知" else "收藏于 "+DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withZone(zone).format(Instant.parse(addedAt))
