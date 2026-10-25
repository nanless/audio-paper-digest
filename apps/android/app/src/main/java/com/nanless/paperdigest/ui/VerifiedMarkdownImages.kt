package com.nanless.paperdigest.ui

import org.commonmark.node.AbstractVisitor
import org.commonmark.node.Image
import org.commonmark.node.Link
import org.commonmark.parser.Parser

/** Root-verified image bytes have their own budget; CommonMark decides which occurrences actually are images. */
internal data class CompactMarkdown(val markdown:String,val images:Map<String,String>)
internal fun compactVerifiedImageData(markdown:String,verified:Map<String,String>):CompactMarkdown {
 require(markdown.length<=96*1024*1024){"原图文材料超过安全读取上限"}
 data class Replacement(val start:Int,val token:String,val original:String)
 val replacements=mutableListOf<Replacement>();val images=LinkedHashMap(verified)
 val byLength=verified.entries.filter{it.key.startsWith("data:image/")}.groupBy{it.key.length}
 val result=StringBuilder();val nonce=java.util.UUID.randomUUID().toString();var ordinal=0
 fun appendRange(from:Int,to:Int){require(result.length.toLong()+to-from<=1_000_000){"正文或代码超过安全渲染上限，原材料仍保留"};result.append(markdown,from,to)}
 var copied=0;var search=0
 while(true){
  val start=markdown.indexOf("data:image/",search);if(start<0)break
  val comma=markdown.indexOf(',',start)
  if(comma<0||comma-start>100||!markdown.substring(start,comma).matches(Regex("data:image/(png|jpeg|webp|gif|svg\\+xml);base64"))){search=start+11;continue}
  var end=comma+1
  while(end<markdown.length&&(markdown[end] in 'A'..'Z'||markdown[end] in 'a'..'z'||markdown[end] in '0'..'9'||markdown[end] in "+/="))end++
  search=end
  // Match the source range without allocating another potentially 24MiB URI string.
  val entry=byLength[end-start]?.firstOrNull{markdown.regionMatches(start,it.key,0,it.key.length)}?:continue
  appendRange(copied,start)
  val token="https://paperdigest-offline.invalid/$nonce/${ordinal++}";val at=result.length
  require(result.length+token.length<=1_000_000){"正文或代码超过安全渲染上限，原材料仍保留"};result.append(token)
  replacements+=Replacement(at,token,entry.key);images[token]=entry.value;copied=end
 }
 appendRange(copied,markdown.length)
 if(replacements.isEmpty())return CompactMarkdown(result.toString(),images)
 val imageDestinations=mutableSetOf<String>();val linkDestinations=mutableSetOf<String>()
 Parser.builder().build().parse(result.toString()).accept(object:AbstractVisitor(){
  override fun visit(image:Image){imageDestinations+=image.destination;visitChildren(image)}
  override fun visit(link:Link){linkDestinations+=link.destination;visitChildren(link)}
 })
 val final=StringBuilder();var cursor=0
 fun appendFinal(text:String){require(final.length.toLong()+text.length<=1_000_000){"正文或代码超过安全渲染上限，原材料仍保留"};final.append(text)}
 replacements.forEach{replacement->
  appendFinal(result.substring(cursor,replacement.start))
  val actualImage=replacement.token in imageDestinations&&replacement.token !in linkDestinations
  appendFinal(if(actualImage)replacement.token else replacement.original)
  if(!actualImage)images.remove(replacement.token)
  cursor=replacement.start+replacement.token.length
 }
 appendFinal(result.substring(cursor))
 return CompactMarkdown(final.toString(),images)
}
