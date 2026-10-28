package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.delay
import org.json.JSONObject

/** These links describe the actual input pages, not page numbers guessed from model prose. */
@OptIn(ExperimentalLayoutApi::class)
@Composable internal fun SavedStudySourceLinks(session: JSONObject, busy: Boolean, action: Action) {
    val source = savedStudySource(session) ?: return
    var more by remember(source) { mutableStateOf(false) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        source.pages.take(6).forEach { page ->
            TextButton({ action("pdf.studySource.open", obj("sessionID" to source.sessionID, "page" to page)) }, enabled = !busy) {
                Text("原文物理页 $page")
            }
        }
        if (source.pages.size > 6) Box {
            TextButton({ more = true }, enabled = !busy) { Text("其余原文页…") }
            DropdownMenu(more, { more = false }) {
                source.pages.drop(6).forEach { page ->
                    DropdownMenuItem({ Text("原文物理页 $page") }, {
                        more = false; action("pdf.studySource.open", obj("sessionID" to source.sessionID, "page" to page))
                    }, enabled = !busy)
                }
            }
        }
    }
}

/** Separate immutable record/response scopes also retire callbacks from an old rendered answer. */
@Composable internal fun SavedStudyAnswerDocument(state: UiState, session: JSONObject, html: String, action: Action) {
    val identity = studyAnswerPositionIdentity(session)
    if (identity == null) { StaticDocument(html, state.settings.optInt("font", 18)); return }
    key(identity.binding) { BoundStudyAnswerDocument(state, session, identity, html, action) }
}

@Composable private fun BoundStudyAnswerDocument(
    state: UiState, session: JSONObject, identity: StudyAnswerPositionIdentity, html: String, action: Action
) {
    val saved = savedStudyAnswerScroll(state.personal, session)
    var scroll by remember(identity.binding) { mutableIntStateOf(saved) }
    val latestScroll by rememberUpdatedState(scroll)
    val latestSaved by rememberUpdatedState(saved)
    val latestAction by rememberUpdatedState(action)
    fun persist(offset: Int) = latestAction("personal.studyScroll", obj("sessionID" to identity.sessionID, "binding" to identity.binding, "scroll" to offset))
    LaunchedEffect(identity.binding, scroll) { delay(350); if (scroll != latestSaved) persist(scroll) }
    DisposableEffect(identity.binding) {
        onDispose { if (latestScroll != latestSaved) persist(latestScroll) }
    }
    // StaticDocument already suppresses its initial restoration callbacks; do not persist a load-time zero.
    StaticDocument(html, state.settings.optInt("font", 18), scroll, { scroll = it })
}
