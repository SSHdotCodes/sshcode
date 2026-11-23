package com.example.sshcode.quest

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

internal sealed interface VoiceAction {
    data class Insert(val text: String) : VoiceAction
    data object Send : VoiceAction
    companion object {
        fun from(transcript: String): VoiceAction {
            val value = transcript.trim()
            return if (value.lowercase().trimEnd('.', '!', '?') == "send it") Send else Insert(value)
        }
    }
}

/** A recognizer may finish before the user lets go. Never insert or send while held. */
internal class VoiceDraft {
    var holding = true
        private set
    private var result: String? = null
    fun finish(text: String): VoiceAction? {
        result = text.trim().takeIf { it.isNotEmpty() }
        return if (holding) null else take()
    }
    fun release(): VoiceAction? { holding = false; return take() }
    private fun take(): VoiceAction? = result?.let { result = null; VoiceAction.from(it) }
}

internal fun systemSpeechServices(context: Context): List<ComponentName> {
    // Horizon can hide these services from app-level queries despite exposing a
    // default recognizer. Let the system speech manager resolve explicit bindings.
    val preferred = Settings.Secure.getString(context.contentResolver, "voice_recognition_service")
        ?.let(ComponentName::unflattenFromString)
    return (listOfNotNull(preferred) + listOf(
        ComponentName("com.oculus.systemintelligence", "com.oculus.systemintelligence.android.speech.OnDeviceRecognitionService"),
        ComponentName("com.oculus.systemintelligence", "com.oculus.systemintelligence.asr.service.RecognitionService"),
    )).distinct().filter { it.packageName == "com.oculus.systemintelligence" }
}

/** Explicit press-and-hold input through Meta's installed system recognizers. */
internal class VoiceController(
    private val activity: Activity,
    private val event: (WindowSlot, String, String?) -> Unit,
    private val status: (WindowSlot, String) -> Unit,
) {
    private var recognizer: SpeechRecognizer? = null
    private var target: WindowSlot? = null
    private var permissionTarget: WindowSlot? = null
    private var draft: VoiceDraft? = null
    private var listening = false
    private var awaitingResult = false
    private var generation = 0
    private var candidates = emptyList<ComponentName>()
    private var candidateIndex = 0
    private val handler = Handler(Looper.getMainLooper())
    private val timeout = Runnable { target?.let { fail(it, "Dictation timed out. Hold the microphone to try again.") } }

    fun press(slot: WindowSlot) {
        if (draft != null || awaitingResult) return
        target = slot
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissionTarget = slot
            status(slot, "Allow microphone access for dictation, then hold the microphone again. Release inserts; ‘send it’ sends.")
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), PERMISSION_REQUEST)
            Log.i(TAG, "voice permission requested")
            return
        }
        candidates = systemSpeechServices(activity)
        if (candidates.isEmpty()) { fail(slot, "System dictation is unavailable. Use the keyboard microphone."); return }
        draft = VoiceDraft()
        candidateIndex = 0
        start(slot)
    }

    private fun start(slot: WindowSlot) {
        val currentGeneration = ++generation
        val component = candidates[candidateIndex]
        recognizer?.destroy()
        val speech = runCatching { SpeechRecognizer.createSpeechRecognizer(activity, component) }
            .getOrElse { fail(slot, "Could not connect to system dictation. Try again."); return }
        recognizer = speech
        speech.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                if (generation != currentGeneration) return
                Log.i(TAG, "voice ready component=${component.flattenToShortString()}")
                status(slot, "Listening · release to insert. Say ‘send it’ to send.")
            }
            override fun onBeginningOfSpeech() { if (generation == currentGeneration) Log.i(TAG, "voice speech began") }
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {
                if (generation != currentGeneration) return
                listening = false; awaitingResult = true
                handler.postDelayed(timeout, 8000)
                Log.i(TAG, "voice speech ended")
            }
            override fun onError(error: Int) {
                if (generation != currentGeneration) return
                Log.i(TAG, "voice error=$error component=${component.flattenToShortString()}")
                handler.removeCallbacks(timeout)
                val hasMicrophonePermission = activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                val bindingError = error in listOf(SpeechRecognizer.ERROR_CLIENT, SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED) ||
                    (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS && hasMicrophonePermission)
                if (bindingError && draft?.holding == true && candidateIndex + 1 < candidates.size) {
                    candidateIndex++; start(slot); return
                }
                val message = when (error) {
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> if (hasMicrophonePermission)
                        "System dictation could not access the microphone. Keep SSHCode open and try again."
                    else "Microphone access is needed. Hold the microphone and allow access."
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT, SpeechRecognizer.ERROR_NO_MATCH -> "No speech heard. Hold the microphone to try again."
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "The microphone is busy. Try again in a moment."
                    else -> "Dictation ended (error $error). Hold the microphone to try again."
                }
                fail(slot, message)
            }
            override fun onResults(results: Bundle?) {
                if (generation != currentGeneration) return
                listening = false; awaitingResult = false
                handler.removeCallbacks(timeout)
                val text = transcript(results)
                Log.i(TAG, "voice final chars=${text.length}")
                if (text.isBlank()) { fail(slot, "No speech heard. Hold the microphone to try again."); return }
                val action = draft?.finish(text)
                if (action != null) deliver(slot, action) else status(slot, "$text\nRelease to insert.")
            }
            override fun onPartialResults(partialResults: Bundle?) {
                if (generation != currentGeneration) return
                val text = transcript(partialResults)
                if (text.isNotBlank()) status(slot, text)
                Log.i(TAG, "voice partial chars=${text.length}")
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        status(slot, "Connecting to system dictation…")
        Log.i(TAG, "voice start component=${component.flattenToShortString()}")
        runCatching { listening = true; speech.startListening(intent) }
            .onFailure { fail(slot, "Could not start system dictation. Try again.") }
    }

    fun release() {
        val slot = target ?: return
        val action = draft?.release()
        if (action != null) { deliver(slot, action); return }
        if (listening) {
            listening = false; awaitingResult = true
            status(slot, "Finishing dictation…")
            recognizer?.stopListening()
            handler.postDelayed(timeout, 8000)
            Log.i(TAG, "voice released")
        }
    }
    fun permissionResult(granted: Boolean) {
        permissionTarget?.let { status(it, if (granted) "Microphone ready. Hold the microphone or A / X to dictate." else "Microphone access was declined. Use the keyboard, or allow access when prompted.") }
        permissionTarget = null
        Log.i(TAG, "voice permission granted=$granted")
    }
    private fun transcript(bundle: Bundle?) = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
    private fun deliver(slot: WindowSlot, action: VoiceAction) {
        cancel()
        when (action) {
            VoiceAction.Send -> event(slot, "send", null)
            is VoiceAction.Insert -> event(slot, "insertText", action.text)
        }
        status(slot, "")
    }
    private fun fail(slot: WindowSlot, message: String) {
        cancel()
        event(slot, "focusComposer", null)
        status(slot, message)
    }
    fun cancelFor(slot: WindowSlot) {
        if (target === slot) cancel()
        if (permissionTarget === slot) permissionTarget = null
    }
    fun cancel() {
        generation++
        handler.removeCallbacks(timeout)
        recognizer?.cancel(); draft = null; listening = false; awaitingResult = false; target = null
    }
    fun close() { cancel(); permissionTarget = null; recognizer?.destroy(); recognizer = null }
    companion object { const val PERMISSION_REQUEST = 30; private const val TAG = "SSHCodeQuest" }
}
