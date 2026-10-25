package com.nanless.paperdigest.ui;
import org.json.JSONObject;import org.junit.Test;import static org.junit.Assert.*;import java.util.Collections;
public class IndependentContractTypeTest {
 private JSONObject session() throws org.json.JSONException {return new JSONObject().put("id","synthetic-original").put("paperID","synthetic-paper").put("kind","study").put("status","complete").put("source",new JSONObject().put("paperID","synthetic-paper").put("kind","pdf-page")).put("usage",new JSONObject().put("input_tokens",5));}
 private JSONObject job() throws org.json.JSONException {return new JSONObject().put("id","synthetic-original").put("paperID","synthetic-paper").put("kind","model.run");}
 @Test public void absentLegacyContractRemainsAttributable() throws org.json.JSONException {JSONObject s=session();assertSame(s,StudyRecordPresentationKt.taskStudySession(job(),Collections.singletonList(s)));}
 @Test public void unknownStringContractRemainsUnattributed() throws org.json.JSONException {assertNull(StudyRecordPresentationKt.taskStudySession(job(),Collections.singletonList(session().put("inputContract","synthetic-future-contract"))));}
 @Test public void explicitNumericContractMustNotBecomeAbsentLegacyContract() throws org.json.JSONException {assertNull("Malformed declared contract must not grant task provenance or fees",StudyRecordPresentationKt.taskStudySession(job(),Collections.singletonList(session().put("inputContract",4))));}
 @Test public void explicitBooleanContractMustNotBecomeAbsentLegacyContract() throws org.json.JSONException {assertNull("Malformed declared contract must not grant task provenance or fees",StudyRecordPresentationKt.taskStudySession(job(),Collections.singletonList(session().put("inputContract",false))));}
}
