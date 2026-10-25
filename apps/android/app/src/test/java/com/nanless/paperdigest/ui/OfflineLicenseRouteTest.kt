package com.nanless.paperdigest.ui

import org.junit.Assert.*
import org.junit.Test

class OfflineLicenseRouteTest {
    @Test fun fixedIndexAndRelativeResolvedLocalPagesHaveAssetOnlyPaths() {
        assertEquals("licenses/index.html", OfflineLicenseRoute.assetPath(OfflineLicenseRoute.INDEX))
        assertEquals("licenses/artifacts/000.html", OfflineLicenseRoute.assetPath("https://paperdigest-offline.invalid/licenses/artifacts/000.html"))
        assertEquals("licenses/texts/abc.txt", OfflineLicenseRoute.assetPath("https://paperdigest-offline.invalid/licenses/texts/abc.txt#original"))
    }
    @Test fun noOtherOriginCredentialsPortSchemeOrMethodMayReachAssets() {
        for (value in listOf("http://paperdigest-offline.invalid/licenses/index.html", "https://example.invalid/licenses/index.html", "https://u@paperdigest-offline.invalid/licenses/index.html", "https://paperdigest-offline.invalid:443/licenses/index.html", "file:///licenses/index.html", "content://paperdigest-offline.invalid/licenses/index.html", "javascript:alert(1)")) assertNull(value, OfflineLicenseRoute.assetPath(value))
        assertNull(OfflineLicenseRoute.assetPath(OfflineLicenseRoute.INDEX, "POST"))
    }
    @Test fun traversalEncodedSeparatorsAndAmbiguousSpellingCannotEscapeFixedSubtree() {
        for (tail in listOf("../personal.json", "%2e%2e/personal.json", "documents/%2Fsecret.txt", "documents/a%5cb.txt", "documents//a.txt", "documents/./a.txt")) assertNull(tail, OfflineLicenseRoute.assetPath("https://paperdigest-offline.invalid/licenses/$tail"))
    }
    @Test fun unrelatedAppAssetsQueryAndActiveFileTypesAreRejected() {
        for (value in listOf("https://paperdigest-offline.invalid/published/sample.json", OfflineLicenseRoute.INDEX+"?destination=elsewhere", "https://paperdigest-offline.invalid/licenses/a.js", "https://paperdigest-offline.invalid/licenses/a.svg", "https://paperdigest-offline.invalid/licenses/")) assertNull(value, OfflineLicenseRoute.assetPath(value))
    }
}
