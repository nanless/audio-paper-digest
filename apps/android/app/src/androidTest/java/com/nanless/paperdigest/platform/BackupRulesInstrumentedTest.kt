package com.nanless.paperdigest.platform

import android.content.pm.ApplicationInfo
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.R
import org.junit.Assert.*
import org.junit.Test
import org.xmlpull.v1.XmlPullParser

/** Checks compiled resources, without contacting a backup transport or modifying any workspace. */
class BackupRulesInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val domains = setOf("root", "file", "database", "sharedpref", "external",
        "device_root", "device_file", "device_database", "device_sharedpref")

    private fun verifyExclusions(resource: Int, root: String, section: String? = null) {
        val parser = context.resources.getXml(resource)
        try {
            val exclusions = mutableListOf<Pair<String?, String?>>()
            var firstTag: String? = null
            var active = section == null
            var sections = 0
            var includes = 0
            while (parser.eventType != XmlPullParser.END_DOCUMENT) {
                if (parser.eventType == XmlPullParser.START_TAG) {
                    if (firstTag == null) firstTag = parser.name
                    if (parser.name == section) {
                        active = true; sections++
                        if (section == "cloud-backup") assertEquals("true", parser.getAttributeValue(null, "disableIfNoEncryptionCapabilities"))
                    }
                    if (active && parser.name == "include") includes++
                    if (active && parser.name == "exclude") exclusions += parser.getAttributeValue(null, "domain") to parser.getAttributeValue(null, "path")
                } else if (parser.eventType == XmlPullParser.END_TAG && parser.name == section) active = false
                parser.next()
            }
            assertEquals(root, firstTag)
            if (section != null) assertEquals("The requested transfer mode must be explicitly configured", 1, sections)
            assertEquals("No route, key, research or future file may be implicitly included", 0, includes)
            assertEquals("Every storage domain must be excluded exactly once", domains.size, exclusions.size)
            assertEquals(domains.map { it to "." }.toSet(), exclusions.toSet())
        } finally { parser.close() }
    }

    @Test fun legacyCompiledRulesExcludeAllStorageDomainsAndBackupIsDisabled() {
        assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
        verifyExclusions(R.xml.backup_rules, "full-backup-content")
    }

    @Test fun cloudCompiledRulesExcludeEveryStorageDomain() {
        verifyExclusions(R.xml.data_extraction_rules, "data-extraction-rules", "cloud-backup")
    }

    @Test fun deviceTransferCompiledRulesExcludeEveryStorageDomain() {
        verifyExclusions(R.xml.data_extraction_rules, "data-extraction-rules", "device-transfer")
    }
}
