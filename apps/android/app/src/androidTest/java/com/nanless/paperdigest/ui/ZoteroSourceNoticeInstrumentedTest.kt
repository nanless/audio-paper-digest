package com.nanless.paperdigest.ui
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
class ZoteroSourceNoticeInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 @Test fun realPreparedSourceGapIsShownAsTextBeforeUserConfirmsArchive(){
  val warning="旧网站原发布记录未绑定；不能声称全部未知元数据已保存。 <script>literal</script>"
  val prepared=JSONObject().put("paperID","paper-a").put("preparedID","original-journal").put("roles",JSONArray()).put("notices",JSONArray(listOf(warning)))
  compose.setContent{ZoteroArchiveDialog(UiState(selectedPaperId="paper-a",zotero=JSONObject().put("libraryID","123").put("prepared",prepared)),{_,_->error("Viewing must not start archive")},{})}
  compose.onNodeWithText(warning).assertExists();compose.onNodeWithText("确认存档").assertExists()
 }
}
