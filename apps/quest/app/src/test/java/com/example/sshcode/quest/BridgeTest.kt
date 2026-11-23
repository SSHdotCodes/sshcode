package com.example.sshcode.quest

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BridgeTest {
    @Test fun pairingAcceptsOnlyHttpOriginsWithPairToken() {
        assertTrue(PanelUrls.isPairing("http://localhost:3997/pair#token=test-only"))
        assertEquals("https://server.example", PanelUrls.origin("https://server.example:443/pair#token=test-only"))
        assertFalse(PanelUrls.isPairing("https://server.example/overview#token=test-only"))
        assertFalse(PanelUrls.isPairing("https://server.example/pair#token="))
        assertNull(PanelUrls.origin("file:///pair#token=test-only"))
        assertNull(PanelUrls.origin("https://user:password@server.example"))
        assertNull(PanelUrls.origin("http://server.example:99999"))
    }
    @Test fun threadRoutesEncodeSegmentsRatherThanTrustingThemAsPaths() {
        assertEquals("http://localhost:3997/env/a%2Fb%20%23%3F?sshcodePanel=thread",
            PanelUrls.panel("http://localhost:3997", "thread", "env", "a/b #?"))
    }
    @Test fun feedSelectionIsIndependentOfPanelRole() {
        assertEquals("http://localhost:3997/new?sshcodePanel=new&sshcodeFeed=1",
            PanelUrls.panel("http://localhost:3997", "new", feed = true))
        assertEquals("http://localhost:3997/overview?sshcodePanel=overview",
            PanelUrls.panel("http://localhost:3997", "overview"))
        assertEquals("http://localhost:3997/e/t?sshcodePanel=thread&sshcodeFeed=1",
            PanelUrls.panel("http://localhost:3997", "thread", "e", "t", feed = true))
    }
    @Test fun bridgeIgnoresMalformedOversizedAndUnknownVersionMessages() {
        val calls = mutableListOf<String>()
        val bridge = QuestBridge { name, _ -> calls += name }
        bridge.ready("not-json")
        bridge.ready("""{"v":2,"role":"overview"}""")
        bridge.postThreads("x".repeat(128_001))
        assertTrue(calls.isEmpty())
        bridge.ready("""{"v":1,"role":"overview","path":"/overview"}""")
        bridge.openThread("""{"environmentId":"e","threadId":"t"}""")
        assertEquals(listOf("ready", "openThread"), calls)
    }
    @Test fun dictationIsJsonEncodedBeforeJavascriptEvaluation() {
        val text = "'); alert('injected'); //\n\"hello\""
        val script = questEvent("insertText", text)
        val detail = script.substringAfter("{detail:").substringBeforeLast("}));")
        assertEquals(text, JSONObject(detail).getString("text"))
        assertEquals("insertText", JSONObject(detail).getString("type"))
    }
    @Test fun statusParsingBoundsTitlesAndHandlesUnsupportedHarnesses() {
        val info = ThreadInfo.parse(JSONObject().put("environmentId", "e").put("threadId", "t")
            .put("harness", "unknown").put("state", "unknown").put("title", "x".repeat(1000)))!!
        assertNull(info.harness)
        assertEquals("idle", info.state)
        assertEquals(160, info.title.length)
        assertNull(ThreadInfo.parse(JSONObject()))
    }
}
