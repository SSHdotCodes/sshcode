package com.example.sshcode.quest

import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Exercises Android's actual JavaScript interface, not a Kotlin-only mock. */
@RunWith(AndroidJUnit4::class)
class BridgeWebViewTest {
    @Test fun realWebViewCanCallBridgeAndReceiveComposerEvents() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val ready = CountDownLatch(1)
        val received = CountDownLatch(1)
        var web: WebView? = null
        instrumentation.runOnMainSync {
            web = WebView(instrumentation.targetContext).apply {
                settings.javaScriptEnabled = true
                addJavascriptInterface(QuestBridge { method, json ->
                    if (method == "ready") ready.countDown()
                    if (method == "openThread" && json.optString("threadId") == "dictated text") received.countDown()
                }, "SSHCodeQuest")
                loadDataWithBaseURL("https://quest-test.invalid/", """
                    <script>
                    window.addEventListener('sshcode-quest', e => {
                      if (e.detail.type === 'insertText') SSHCodeQuest.openThread(JSON.stringify({environmentId:'test',threadId:e.detail.text}));
                    });
                    SSHCodeQuest.ready(JSON.stringify({v:1,role:'overview',path:'/overview'}));
                    </script>
                """.trimIndent(), "text/html", "UTF-8", null)
            }
        }
        try {
            assertTrue("WebView JavaScript interface did not become ready", ready.await(10, TimeUnit.SECONDS))
            instrumentation.runOnMainSync { web!!.evaluateJavascript(questEvent("insertText", "dictated text"), null) }
            assertTrue("Composer event was not delivered", received.await(10, TimeUnit.SECONDS))
        } finally { instrumentation.runOnMainSync { web!!.destroy() } }
    }
}
