package com.example.sshcode.quest

import org.junit.Assert.*
import org.junit.Test

class VoiceActionTest {
    @Test fun waitsForReleaseEvenWhenTheRecognizerFinishesEarly() {
        val draft = VoiceDraft()
        assertNull(draft.finish("send it"))
        assertTrue(draft.holding)
        assertEquals(VoiceAction.Send, draft.release())
        assertNull(draft.release())
    }
    @Test fun acceptsTheFinalResultAfterRelease() {
        val draft = VoiceDraft()
        assertNull(draft.release())
        assertEquals(VoiceAction.Insert("dictated text"), draft.finish(" dictated text "))
        assertNull(draft.release())
        assertNull(draft.finish("  "))
    }
    @Test fun sendsOnlyAnExplicitStandaloneCommand() {
        assertEquals(VoiceAction.Send, VoiceAction.from(" Send it! "))
        assertEquals(VoiceAction.Send, VoiceAction.from("send it"))
        assertEquals(VoiceAction.Insert("Please send it after review"), VoiceAction.from("Please send it after review"))
        assertEquals(VoiceAction.Insert("don't send it"), VoiceAction.from("don't send it"))
    }
}
