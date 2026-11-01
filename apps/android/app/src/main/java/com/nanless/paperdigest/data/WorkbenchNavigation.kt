package com.nanless.paperdigest.data

/** Display grouping only. Original row kind, source identity and paper capabilities are unchanged. */
fun workbenchConferenceDirectory(record:PublishedAggregate)=record.sourceURL==PublishedAggregateReader.SITE+"conferences/"
fun workbenchConferenceTask(record:PublishedAggregate)=record.conferenceScope=="task" ||
    (record.conferenceScope==null && java.net.URI(record.sourceURL).path.trimEnd('/').substringAfterLast('/', "").contains("-task-"))
fun workbenchAggregateInSection(record:PublishedAggregate,section:String)=when(section){
    "all"->true
    "conference"->record.kind=="conference"||workbenchConferenceDirectory(record)
    "page"->record.kind=="page"&&!workbenchConferenceDirectory(record)
    else->record.kind==section
}
fun workbenchAggregateOrder(records:List<PublishedAggregate>):List<PublishedAggregate> = records.sortedWith(
    compareBy<PublishedAggregate>{when{workbenchConferenceDirectory(it)->-1;it.kind=="daily"->0;it.kind=="conference"->1;else->2}}
        .thenBy{if(workbenchConferenceTask(it))1 else 0}
        .thenByDescending{it.displayDate.orEmpty()}.thenBy{it.titleZh}.thenBy{it.id})
