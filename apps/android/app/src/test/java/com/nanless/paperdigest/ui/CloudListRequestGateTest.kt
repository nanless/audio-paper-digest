package com.nanless.paperdigest.ui
import org.junit.Assert.*
import org.junit.Test
class CloudListRequestGateTest {
 @Test fun actualTargetOrMonthMismatchRejectsLateResponse(){val gate=CloudListRequestGate();val ticket=gate.begin("A","2026-01");assertTrue(gate.accepts(ticket,"A","2026-01"));assertFalse(gate.accepts(ticket,"B","2026-01"));assertFalse(gate.accepts(ticket,"A","2026-02"))}
 @Test fun monthAndDraftABARetireEvenIfValuesReturn(){val gate=CloudListRequestGate();val ticket=gate.begin("A","2026-01");gate.invalidate();gate.invalidate();assertFalse(gate.accepts(ticket,"A","2026-01"))}
 @Test fun newerRequestOwnsReplyAndStaleCompletionCannotBecomeCurrent(){val gate=CloudListRequestGate();val old=gate.begin("A","2026-01");val current=gate.begin("A","2026-01");assertFalse(gate.accepts(old,"A","2026-01"));assertTrue(gate.accepts(current,"A","2026-01"))}
 @Test fun missingActualContextNeverPublishesAndDisposedOwnerRetires(){val gate=CloudListRequestGate();assertFalse(gate.accepts(gate.begin("","2026-01"),"","2026-01"));val ticket=gate.begin("A","2026-01");gate.invalidate();assertFalse(gate.accepts(ticket,"A","2026-01"))}
}
