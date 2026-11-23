package com.example.sshcode.quest

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** A real system binding with no WebView or composer, so this cannot send a chat. */
@RunWith(AndroidJUnit4::class)
class VoiceRecognizerTest {
    @Test fun metaRecognizerStartsAndReportsAnOutcome() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val services = systemSpeechServices(context)
        assumeTrue("Allow the app's first-use microphone prompt before running this test",
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        for (component in services) checkService(component)
    }

    private fun checkService(component: android.content.ComponentName) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val outcome = CountDownLatch(1)
        var speech: SpeechRecognizer? = null
        val handler = Handler(Looper.getMainLooper())
        val release = Runnable { speech?.stopListening() }
        instrumentation.runOnMainSync {
            speech = SpeechRecognizer.createSpeechRecognizer(context, component).apply {
                setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        Log.i("SSHCodeQuest", "voice device test ready component=${component.flattenToShortString()}")
                        handler.postDelayed(release, 2000)
                    }
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onError(error: Int) {
                        Log.i("SSHCodeQuest", "voice device test error=$error component=${component.flattenToShortString()}")
                        outcome.countDown()
                    }
                    override fun onResults(results: Bundle?) {
                        val length = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.length ?: 0
                        Log.i("SSHCodeQuest", "voice device test result chars=$length component=${component.flattenToShortString()}")
                        outcome.countDown()
                    }
                    override fun onPartialResults(partialResults: Bundle?) {}
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
                Log.i("SSHCodeQuest", "voice device test start component=${component.flattenToShortString()}")
                startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true))
            }
        }
        try { assertTrue("System recognizer did not return a result or error", outcome.await(15, TimeUnit.SECONDS)) }
        finally { instrumentation.runOnMainSync { handler.removeCallbacks(release); speech?.destroy() } }
    }
}
