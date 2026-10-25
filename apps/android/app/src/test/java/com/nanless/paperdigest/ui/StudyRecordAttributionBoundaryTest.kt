package com.nanless.paperdigest.ui
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class StudyRecordAttributionBoundaryTest {
 private fun s(owner:String="p")=JSONObject().put("id","original").put("paperID",owner).put("kind","study").put("source",JSONObject().put("kind","pdf-page"))
 @Test fun duplicatedIDNeverChoosesFirstEvenIfIdentical(){val row=s();assertNull(jobSession(JSONObject().put("id","original"),listOf(row,JSONObject(row.toString()))))}
 @Test fun declaredJobOwnerConflictRefusesNavigation(){assertNull(jobSession(JSONObject().put("id","original").put("paperID","other"),listOf(s())))}
 @Test fun declaredSourceOwnerConflictRefusesNavigation(){val row=s().put("source",JSONObject().put("kind","pdf-page").put("paperID","other"));assertNull(jobSession(JSONObject().put("id","original"),listOf(row)))}
 @Test fun conflictingExplicitPointersCannotSelectConvenientOne(){assertNull(jobSession(JSONObject().put("id","job").put("sessionID","original").put("result",JSONObject().put("sessionID","other")),listOf(s(),s().put("id","other"))))}
 @Test fun falseIssuedAndNotIssuedDoesNotProveNoDurableFloor(){assertEquals("金额未确认，不表示免费",sessionChargeLabel(s().put("requestIssued",false).put("charge","not-issued")))}
 @Test fun stringTrueIsNotKnownCost(){assertEquals("金额未确认，不表示免费",sessionChargeLabel(s().put("costKnown","true").put("cost",2)))}
 @Test fun negativeOrTextAmountNeverBecomesKnownCost(){for(value in listOf<Any>(-1,"2.00",JSONObject.NULL)){assertEquals("金额未确认，不表示免费",sessionChargeLabel(s().put("costKnown",true).put("cost",value)))}}
}
