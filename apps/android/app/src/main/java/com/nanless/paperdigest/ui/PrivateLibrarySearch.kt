package com.nanless.paperdigest.ui

import org.json.JSONObject

/** Search only user note/annotation text. Source records, request inputs and usage are never serialized. */
internal fun privateLibraryHits(personal:JSONObject,query:String):Set<String> {
    val needle=query.trim();if(needle.isEmpty())return emptySet()
    return buildSet {
        val notes=personal.optJSONObject("notes");notes?.keys()?.forEach{id->if(notes.optJSONObject(id)?.optString("text").orEmpty().contains(needle,true))add(id)}
        val annotations=personal.optJSONObject("annotations");annotations?.keys()?.forEach{id->val items=annotations.optJSONArray(id);if(items!=null&&(0 until items.length()).any{i->val item=items.optJSONObject(i);item!=null&&(item.optString("text").contains(needle,true)||item.optString("comment").contains(needle,true))})add(id)}
    }
}
