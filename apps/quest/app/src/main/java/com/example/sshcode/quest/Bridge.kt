package com.example.sshcode.quest

import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/** Only origins are persisted. Pairing fragments never reach disk or diagnostics. */
object PanelUrls {
    fun origin(value: String): String? = runCatching {
        val uri = URI(value)
        require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank())
        require(uri.rawUserInfo == null)
        val scheme = uri.scheme.lowercase()
        val port = uri.port
        require(port == -1 || port in 1..65535)
        val defaultPort = if (scheme == "https") 443 else 80
        "$scheme://${uri.host.lowercase()}${if (port == -1 || port == defaultPort) "" else ":$port"}"
    }.getOrNull()

    fun isPairing(value: String): Boolean = runCatching {
        val uri = URI(value)
        origin(value) != null && uri.path == "/pair" &&
            uri.rawFragment?.split('&')?.any { it.startsWith("token=") && it.length > 6 } == true
    }.getOrDefault(false)

    private fun segment(value: String) = URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")
        .replace("%21", "!").replace("%27", "'").replace("%28", "(").replace("%29", ")").replace("%7E", "~")
    fun threadPath(environment: String, thread: String) = "/${segment(environment)}/${segment(thread)}"
    fun panel(origin: String, role: String, environment: String = "", thread: String = "", feed: Boolean = false): String {
        val path = when (role) {
            "thread" -> threadPath(environment, thread)
            "new" -> "/new"
            else -> "/overview"
        }
        return "$origin$path?sshcodePanel=$role${if (feed) "&sshcodeFeed=1" else ""}"
    }
}

data class ThreadInfo(
    val environmentId: String,
    val threadId: String,
    val title: String,
    val harness: String?,
    val state: String,
    val needsUser: Boolean,
) {
    val key get() = "$environmentId\u0000$threadId"
    companion object {
        fun parse(json: JSONObject): ThreadInfo? {
            val environment = json.optString("environmentId").takeIf { it.isNotBlank() && it.length <= 512 } ?: return null
            val thread = json.optString("threadId").takeIf { it.isNotBlank() && it.length <= 512 } ?: return null
            return ThreadInfo(environment, thread, json.optString("title", "Chat").take(160),
                json.optString("harness").takeIf { it in listOf("claude", "codex", "grok", "muse") },
                json.optString("state", "idle").takeIf { it in listOf("idle", "working", "waiting", "done", "failed") } ?: "idle",
                json.optBoolean("needsUser"))
        }
    }
}

/** Android invokes these methods on its bridge thread. Decode bounded input, then marshal to UI. */
class QuestBridge(private val dispatch: (String, JSONObject) -> Unit) {
    private fun receive(method: String, value: String) {
        if (value.length > 128_000) return
        val json = runCatching { JSONObject(value) }.getOrNull() ?: return
        if (method != "openThread" && json.optInt("v") != 1) return
        dispatch(method, json)
    }
    @JavascriptInterface fun ready(json: String) = receive("ready", json)
    @JavascriptInterface fun postThreads(json: String) = receive("postThreads", json)
    @JavascriptInterface fun panelState(json: String) = receive("panelState", json)
    @JavascriptInterface fun openThread(json: String) = receive("openThread", json)
}

fun questEvent(type: String, text: String? = null): String {
    require(type in listOf("insertText", "send", "focusComposer"))
    val detail = JSONObject().put("type", type)
    if (text != null) detail.put("text", text)
    // JSON encoding prevents dictated text from becoming JavaScript source.
    return "window.dispatchEvent(new CustomEvent('sshcode-quest',{detail:$detail}));"
}
