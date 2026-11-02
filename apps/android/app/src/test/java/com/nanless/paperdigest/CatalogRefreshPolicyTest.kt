package com.nanless.paperdigest

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class CatalogRefreshPolicyTest {
    private val now=Instant.parse("2026-11-03T12:00:00Z").toEpochMilli()
    private val online=CatalogRefreshSettings(false,12)
    @Test fun emptyAndBundledCatalogNeedAFirstCheckEvenWithARecentTimestamp() {
        assertTrue(CatalogRefreshPolicy.due(false,Instant.ofEpochMilli(now).toString(),12,now))
        assertFalse(CatalogRefreshPolicy.due(true,Instant.ofEpochMilli(now).toString(),12,now))
    }
    @Test fun intervalIsHonoredAtItsExactBoundary() {
        assertFalse(CatalogRefreshPolicy.due(true,"2026-11-03T00:00:00.001Z",12,now))
        assertTrue(CatalogRefreshPolicy.due(true,"2026-11-03T00:00:00Z",12,now))
        assertFalse(CatalogRefreshPolicy.due(true,"2026-11-03T00:00:00Z",24,now))
    }
    @Test fun missingInvalidAndFutureTimestampsCannotLeaveTheCatalogPermanentlyFresh() {
        for(saved in listOf(null,"bad-date","2026-11-04T00:00:00Z"))assertTrue(CatalogRefreshPolicy.due(true,saved,12,now))
    }
    @Test fun offlineNeverAdmitsAndDoesNotConsumeTheNextOnlineAttempt() {
        val policy=CatalogRefreshPolicy();assertNull(policy.begin(online.copy(offline=true),false,null,now))
        assertNotNull(policy.begin(online,false,null,now))
    }
    @Test fun repeatedForegroundChecksAfterFailureRespectTheFiveMinuteCooldown() {
        val policy=CatalogRefreshPolicy();assertNotNull(policy.begin(online,false,null,now))
        assertFalse(policy.eligible(online,false,null,now+299_999));assertNull(policy.begin(online,false,null,now+299_999))
        assertNotNull(policy.begin(online,false,null,now+300_000))
    }
    @Test fun cancellingAQueuedCheckOrAnOldAttemptCannotEraseARealFailureCooldown() {
        val policy=CatalogRefreshPolicy();val old=policy.begin(online,false,null,now)
        policy.cancelled(null);assertNull(policy.begin(online,false,null,now+1))
        val newer=policy.begin(online,false,null,now+300_000);assertNotNull(newer)
        policy.cancelled(old);assertNull(policy.begin(online,false,null,now+300_001))
    }
    @Test fun yieldingTheCurrentAttemptToTheUserIsNotAFailure() {
        val policy=CatalogRefreshPolicy();val attempt=policy.begin(online,false,null,now)
        policy.cancelled(attempt);assertNotNull(policy.begin(online,false,null,now+1))
    }
    @Test fun aSuccessfulManualSyncClearsFailureCooldownButItsFreshTimestampStillWins() {
        val policy=CatalogRefreshPolicy();policy.begin(online,false,null,now);policy.completed()
        assertNull(policy.begin(online,true,Instant.ofEpochMilli(now).toString(),now+1))
        assertNotNull(policy.begin(online,false,null,now+1))
    }
    @Test fun unrelatedSettingsDoNotChangeThePeriodicScheduleIdentity() {
        val settings=JSONObject().put("syncHours",12).put("offlineMode",false)
        val before=CatalogRefreshSettings.from(settings)
        settings.put("font",20).put("appearance","dark").put("lastSettingPane","reader")
        assertEquals(before,CatalogRefreshSettings.from(settings))
        assertNotEquals(before,CatalogRefreshSettings.from(settings.put("syncHours",24)))
        assertNotEquals(before,CatalogRefreshSettings.from(settings.put("syncHours",12).put("offlineMode",true)))
    }
}
