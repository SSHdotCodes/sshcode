package com.example.sshcode.quest

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.view.View
import android.webkit.*
import android.widget.FrameLayout
import java.io.ByteArrayInputStream

@SuppressLint("SetJavaScriptEnabled")
class PanelWebView(
    context: Context,
    private val server: String,
    bridge: QuestBridge,
    private val chooser: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean,
    private val paired: () -> Unit,
    private val rendererGone: () -> Unit,
    private val status: (String) -> Unit,
) : WebView(context) {
    private var wasPairing = false
    private var fullscreen: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    init {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setSupportMultipleWindows(true)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
        addJavascriptInterface(bridge, "SSHCodeQuest")
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (PanelUrls.origin(request.url.toString()) == server) return false
                if (request.isForMainFrame) openExternal(request.url)
                return true
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                // addJavascriptInterface is visible to frames. Keep every network frame/resource
                // on the trusted server; external links are delegated to the Quest browser.
                val url = request.url.toString()
                if (PanelUrls.origin(url) == server) return null
                return WebResourceResponse("text/plain", "UTF-8", 403, "External resource", emptyMap(), ByteArrayInputStream(byteArrayOf()))
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (wasPairing && PanelUrls.origin(url) == server && Uri.parse(url).path != "/pair") {
                    wasPairing = false
                    clearHistory()
                    CookieManager.getInstance().flush()
                    paired()
                }
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) status("Could not reach the server. Check its address and connection, then Reload.")
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                status("Web renderer stopped. Close and reopen this panel.")
                (parent as? FrameLayout)?.removeView(this@PanelWebView)
                destroy()
                rendererGone()
                return true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage) = true // Page URLs can contain secrets.
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams) = chooser(callback, params)
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                val container = parent as? FrameLayout ?: return callback.onCustomViewHidden()
                fullscreen = view
                fullscreenCallback = callback
                container.addView(view, FrameLayout.LayoutParams(-1, -1))
            }
            override fun onHideCustomView() {
                (fullscreen?.parent as? FrameLayout)?.removeView(fullscreen)
                fullscreen = null
                fullscreenCallback?.onCustomViewHidden()
                fullscreenCallback = null
            }
            override fun onCreateWindow(view: WebView, dialog: Boolean, gesture: Boolean, message: android.os.Message): Boolean {
                if (!gesture) return false
                val popup = WebView(context)
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        openExternal(request.url)
                        popup.destroy()
                        return true
                    }
                }
                (message.obj as WebViewTransport).webView = popup
                message.sendToTarget()
                return true
            }
        }
        setDownloadListener { url, agent, disposition, mime, _ ->
            if (PanelUrls.origin(url) != server) {
                status("Open this download in the browser.")
            } else runCatching {
                val filename = URLUtil.guessFileName(url, disposition, mime)
                val request = DownloadManager.Request(Uri.parse(url))
                    .setTitle(filename).setMimeType(mime)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .addRequestHeader("User-Agent", agent)
                CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
                (context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                status("Saved to Downloads.")
            }.onFailure { status("Download failed. Try opening it in the browser.") }
        }
    }
    override fun performClick(): Boolean = super.performClick()
    fun pair(url: String) {
        wasPairing = true
        loadUrl(url)
    }
    fun event(type: String, text: String? = null) = evaluateJavascript(questEvent(type, text), null)
    private fun openExternal(uri: Uri) {
        if (uri.scheme !in listOf("https", "http", "mailto")) return
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure { status("No browser is available for this link.") }
    }
    override fun destroy() {
        removeJavascriptInterface("SSHCodeQuest")
        webChromeClient?.onHideCustomView()
        super.destroy()
    }
}
