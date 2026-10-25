package com.nanless.paperdigest.ui
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class ReuseLabelWordingTest {
 @Test fun boolIsExplicitlyOriginalTaskAnnotationAndDoesNotClaimLedgerReadback(){val job=JSONObject().put("id","new-task").put("paperID","paper").put("kind","model.run").put("result",JSONObject().put("reused",true)).put("usage",JSONObject().put("input_tokens",999));val before=job.toString();val label=studyTaskPresentation(job,emptyList())!!;assertEquals("原任务标注复用；原材料版本以原研究记录为准",label.evidence);assertEquals("原任务标注未新增模型请求；原记录用量不计作本次新增用量",label.usage);assertEquals("派发账本本页未单独核验；原请求金额未在本任务核对",label.charge);assertFalse(label.usage.contains("999"));assertEquals(before,job.toString())}
}
