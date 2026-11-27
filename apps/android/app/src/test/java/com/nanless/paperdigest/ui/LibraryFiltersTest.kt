package com.nanless.paperdigest.ui

import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.data.ResourceBadgeSignals
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LibraryFiltersTest {
    private fun paperWithConcepts(
        id: String,
        title: String,
        titleZh: String,
        date: String,
        score: Double?,
        sourceKind: String,
        authors: List<String>,
        tags: List<String>,
        conceptIds: List<String>,
    ): Paper {
        val tagRec = JSONObject().apply {
            put("permalink", "/audio-paper-digest-blog/posts/$id/")
            put("title", title)
            put("titleZh", titleZh)
            put("date", date)
            if (score != null) put("score", score)
            put("sourceKind", sourceKind)
            put("tags", JSONArray(tags))
            put("citation", JSONObject().put("authors", JSONArray(authors)).put("sourceKind", sourceKind))
            put("tagConcepts", JSONArray(conceptIds.map { JSONObject().put("id", it) }))
        }
        val original = JSONObject().put("websiteTagRecords", JSONArray(listOf(tagRec)))
        return Paper(
            id = id,
            title = title,
            titleZh = titleZh,
            authors = authors,
            date = date,
            score = score,
            tags = tags,
            sourceKind = sourceKind,
            blogURL = "https://nanless.github.io/audio-paper-digest-blog/posts/$id/",
            original = original,
        )
    }

    @Test
    fun offlineConferenceVenueParsingAndCollection() {
        val interspeech = parseConferenceVenue("conference:interspeech:2026:paper-01")
        assertEquals(ConferenceVenue("conference:interspeech:2026", "Interspeech 2026"), interspeech)
        assertEquals("NeurIPS 2025", parseConferenceVenue("conference:neurips:2025:abc")?.label)
        assertEquals("ICASSP 2026", parseConferenceVenue("conference:icassp:2026:99")?.label)
        assertNull(parseConferenceVenue("arxiv:2611.00001"))
        assertNull(parseConferenceVenue("conference:bad:year:1"))

        val venueParityCases = listOf(
            "conference:INTERSPEECH:2026:paper-02" to "Interspeech 2026",
            "conference:icassp:2026:999" to "ICASSP 2026",
            "conference:speech_prosody:2026:sp1" to "Speech Prosody 2026",
            "conference:speech-prosody:2026:sp2" to "Speech Prosody 2026",
            "conference:speechprosody:2026:sp3" to "Speech Prosody 2026",
            "conference:Speech-Prosody:2026:sp4" to "Speech Prosody 2026",
            "conference:waspaa:2025:w1" to "WASPAA 2025",
            "conference:asru:2025:a1" to "ASRU 2025",
            "conference:slt:2026:s1" to "SLT 2026",
            "conference:ismir:2026:i1" to "ISMIR 2026",
            "conference:dcase:2026:d1" to "DCASE 2026",
            "conference:taslp:2026:t1" to "TASLP 2026",
            "conference:ieee_acm_taslp:2026:t2" to "TASLP 2026",
            "conference:ieee-acm-taslp:2026:t3" to "TASLP 2026",
            "conference:ieee-acm_taslp:2026:t4" to "TASLP 2026",
            "conference:neurips:2025:abc" to "NeurIPS 2025",
            "conference:nips:2024:n1" to "NeurIPS 2024",
            "conference:icml:2026:m1" to "ICML 2026",
            "conference:iclr:2026:l1" to "ICLR 2026",
            "conference:acl:2026:acl1" to "ACL 2026",
            "conference:emnlp:2026:e1" to "EMNLP 2026",
            "conference:naacl:2026:na1" to "NAACL 2026",
            "conference:aaai:2026:aa1" to "AAAI 2026",
            "conference:ijcai:2026:ij1" to "IJCAI 2026",
            "conference:cvpr:2026:cv1" to "CVPR 2026",
            "conference:iccv:2025:ic1" to "ICCV 2025",
            "conference:eccv:2026:ec1" to "ECCV 2026",
            "conference:acmmm:2026:mm1" to "ACM MM 2026",
            "conference:acm_mm:2026:mm2" to "ACM MM 2026",
            "conference:acm-mm:2026:mm3" to "ACM MM 2026",
            "conference:mm:2026:mm4" to "ACM MM 2026",
            "conference:siggraph:2026:sg1" to "SIGGRAPH 2026",
            "conference:chi:2026:ch1" to "CHI 2026",
            "conference:ubicomp:2026:ub1" to "UbiComp 2026",
            "conference:mobicom:2026:mc1" to "MobiCom 2026",
            "conference:mobisys:2026:ms1" to "MobiSys 2026",
            "conference:sensys:2026:sn1" to "SenSys 2026",
            "conference:odyssey:2026:od1" to "Odyssey 2026",
            "conference:lrec:2026:lr1" to "LREC 2026",
            "conference:coling:2026:co1" to "COLING 2026",
            "conference:eacl:2026:ea1" to "EACL 2026",
            "conference:kdd:2026:kd1" to "KDD 2026",
            "conference:www:2026:ww1" to "WWW 2026",
            "conference:icra:2026:ir1" to "ICRA 2026",
            "conference:iros:2026:io1" to "IROS 2026",
            "conference:corl:2026:cl1" to "CoRL 2026",
            "conference:jmlr:2026:jm1" to "JMLR 2026",
            "conference:tmlr:2026:tm1" to "TMLR 2026",
            "conference:tacl:2026:ta1" to "TACL 2026",
            "conference:spl:2026:sp5" to "SPL 2026",
            "conference:dafx:2026:df1" to "DAFx 2026",
            "conference:chime:2026:cm1" to "CHiME 2026",
            "conference:custom_venue:2026:u1" to "CUSTOM_VENUE 2026",
        )
        for ((paperId, expectedLabel) in venueParityCases) {
            assertEquals("Venue parity for $paperId", expectedLabel, parseConferenceVenue(paperId)?.label)
        }

        val p1 = Paper("conference:interspeech:2026:1", "A", "A")
        val p2 = Paper("conference:interspeech:2026:2", "B", "B")
        val p3 = Paper("conference:icassp:2025:1", "C", "C")
        val p4 = Paper("arxiv:2611.00001", "D", "D")
        val venues = collectConferenceVenues(listOf(p1, p2, p3, p4))
        assertEquals(2, venues.size)
        assertEquals("Interspeech 2026", venues[0].first.label)
        assertEquals(2, venues[0].second)
        assertEquals("ICASSP 2025", venues[1].first.label)
        assertEquals(1, venues[1].second)
    }

    @Test
    fun scoreTierInfoAndPresets() {
        assertEquals("featured", scoreTierInfo(8.6)?.key)
        assertEquals("精选", scoreTierInfo(8.0)?.label)
        assertEquals("high", scoreTierInfo(7.5)?.key)
        assertEquals("recommended", scoreTierInfo(6.2)?.key)
        assertEquals("standard", scoreTierInfo(5.5)?.key)
        assertNull(scoreTierInfo(null))

        assertTrue(matchesMinimumScore(8.0, "8"))
        assertFalse(matchesMinimumScore(7.9, "8"))
        assertTrue(matchesMinimumScore(6.0, "scored"))
        assertFalse(matchesMinimumScore(null, "scored"))
        assertTrue(matchesMinimumScore(null, ""))
    }

    @Test
    fun multiTokenNfkcSearchRelevanceAndFiltersParity() {
        val p1 = paperWithConcepts(
            id = "arxiv:2611.00001",
            title = "Streaming TTS Codec with Low Latency",
            titleZh = "低延迟流式语音合成编解码器",
            date = "2026-11-24",
            score = 8.6,
            sourceKind = "arxiv",
            authors = listOf("Alice Résumé", "Bob Chen"),
            tags = listOf("TTS", "Codec"),
            conceptIds = listOf("artifact.open-source-tool"),
        )
        val p2 = paperWithConcepts(
            id = "conference:interspeech:2026:asr-42",
            title = "Robust Speech Recognition under Noise",
            titleZh = "强噪声下的鲁棒语音识别",
            date = "2026-11-20",
            score = 7.4,
            sourceKind = "conference",
            authors = listOf("Carol Lin"),
            tags = listOf("ASR", "TTS"),
            conceptIds = listOf("artifact.model-weights"),
        )
        val p3 = paperWithConcepts(
            id = "conference:icassp:2026:bench-7",
            title = "Audio Benchmark Corpus",
            titleZh = "音频评测基准数据集",
            date = "2026-11-18",
            score = 6.2,
            sourceKind = "conference",
            authors = listOf("Dave Wu"),
            tags = listOf("Benchmark"),
            conceptIds = listOf("artifact.dataset"),
        )
        val p4 = paperWithConcepts(
            id = "arxiv:2611.00004",
            title = "Unscored Survey on Music Generation",
            titleZh = "音乐生成综述",
            date = "2026-11-10",
            score = null,
            sourceKind = "arxiv",
            authors = listOf("Eve Zhang"),
            tags = listOf("Music"),
            conceptIds = emptyList(),
        )
        val all = listOf(p1, p2, p3, p4)
        val index = WebsiteLibraryIndex(null, all)

        // Multi-token NFKC whitespace AND search across title + diacritic author
        val nfkcHits = index.select(all, WebsiteLibraryCriteria(query = "  ＴＴＳ   resume  "), WebsiteDirection()).papers
        assertEquals(listOf("arxiv:2611.00001"), nfkcHits.map { it.id })

        // Venue label searchable via multi-token AND
        val venueSearch = index.select(all, WebsiteLibraryCriteria(query = "interspeech carol"), WebsiteDirection()).papers
        assertEquals(listOf("conference:interspeech:2026:asr-42"), venueSearch.map { it.id })

        // Relevance score ranks title match (p1) strictly ahead of tag-only match (p2)
        val ttsHits = index.select(all, WebsiteLibraryCriteria(query = "TTS"), WebsiteDirection()).papers
        val ranked = ttsHits.sortedByDescending { index.relevanceScore(it, "TTS") }
        assertEquals(listOf("arxiv:2611.00001", "conference:interspeech:2026:asr-42"), ranked.map { it.id })

        // Conference venue filter
        val venueFiltered = index.select(all, WebsiteLibraryCriteria(venue = "conference:interspeech:2026"), WebsiteDirection()).papers
        assertEquals(listOf("conference:interspeech:2026:asr-42"), venueFiltered.map { it.id })

        // Score presets including "scored"
        val scoredOnly = index.select(all, WebsiteLibraryCriteria(minimum = "scored"), WebsiteDirection()).papers
        assertEquals(3, scoredOnly.size)
        assertFalse(scoredOnly.any { it.id == "arxiv:2611.00004" })

        val featuredOnly = index.select(all, WebsiteLibraryCriteria(minimum = "8"), WebsiteDirection()).papers
        assertEquals(listOf("arxiv:2611.00001"), featuredOnly.map { it.id })

        // Tier 1 offline resources (code / model / dataset / cached demo)
        assertEquals(
            listOf("arxiv:2611.00001"),
            index.select(all, WebsiteLibraryCriteria(resource = "code"), WebsiteDirection()).papers.map { it.id }
        )
        assertEquals(
            listOf("conference:interspeech:2026:asr-42"),
            index.select(all, WebsiteLibraryCriteria(resource = "model"), WebsiteDirection()).papers.map { it.id }
        )
        assertEquals(
            listOf("conference:icassp:2026:bench-7"),
            index.select(all, WebsiteLibraryCriteria(resource = "dataset"), WebsiteDirection()).papers.map { it.id }
        )
        assertEquals(
            listOf("arxiv:2611.00004"),
            index.select(all, WebsiteLibraryCriteria(resource = "demo", cachedDemoIds = setOf("arxiv:2611.00004")), WebsiteDirection()).papers.map { it.id }
        )

        // Tier 2 optional resource-badges merges cleanly with Tier 1
        val tier2 = mapOf("conference:icassp:2026:bench-7" to ResourceBadgeSignals(hasCode = true, hasProjectPage = true))
        val mergedCode = index.select(all, WebsiteLibraryCriteria(resource = "code", resourceBadges = tier2), WebsiteDirection()).papers
        assertEquals(setOf("arxiv:2611.00001", "conference:icassp:2026:bench-7"), mergedCode.map { it.id }.toSet())
    }

    @Test
    fun canonicalPaperIdResolutionAndSearchTokenCap() {
        val arxivPaper = Paper(
            id = "arxiv:2611.10001",
            title = "Canonical arXiv Paper",
            titleZh = "规范编号测试论文",
            sourceVersion = "2611.10001v2",
        )
        val confPaper = Paper(
            id = "conference:interspeech:2026:paper-09",
            title = "Conference Paper",
            titleZh = "会议论文",
        )
        val catalog = listOf(arxivPaper, confPaper)

        // P0 #2: Exact ID, exact sourceVersion, bare arXiv ID, and different versioned arXiv ID all resolve
        assertEquals(arxivPaper, resolvePaperByCanonicalId(catalog, "arxiv:2611.10001"))
        assertEquals(arxivPaper, resolvePaperByCanonicalId(catalog, "2611.10001v2"))
        assertEquals(arxivPaper, resolvePaperByCanonicalId(catalog, "2611.10001v1"))
        assertEquals(arxivPaper, resolvePaperByCanonicalId(catalog, "2611.10001"))
        assertEquals(confPaper, resolvePaperByCanonicalId(catalog, "conference:interspeech:2026:paper-09"))
        assertNull(resolvePaperByCanonicalId(catalog, "2611.99999v1"))
        assertNull(resolvePaperByCanonicalId(catalog, "   "))

        // P2 #19: Search token deduplication & cap at 32 tokens
        val many = (1..50).joinToString(" ") { "tok$it tok$it" }
        val tokens = tokenizeLibraryQuery(many)
        assertEquals(MAX_SEARCH_TOKENS, tokens.size)
        assertEquals(tokens.distinct().size, tokens.size)
        assertEquals("tok1", tokens.first())
        assertEquals("tok32", tokens.last())

        // P1 #12: Precomputed-token relevanceScore & single-pass matchesLibrarySearch
        val idx = WebsiteLibraryIndex(null, catalog)
        val preTokens = tokenizeLibraryQuery("Canonical arXiv")
        assertEquals(idx.relevanceScore(arxivPaper, "Canonical arXiv"), idx.relevanceScore(arxivPaper, "Canonical arXiv", preTokens))
        assertTrue(matchesLibrarySearch(arxivPaper, "   ", null))
        assertTrue(matchesLibrarySearch(arxivPaper, "CANONICAL 2611.10001", null))
        assertFalse(matchesLibrarySearch(arxivPaper, "canonical nonexistent", null))
    }
}
