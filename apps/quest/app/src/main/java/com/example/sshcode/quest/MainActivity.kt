package com.example.sshcode.quest

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.*
import com.meta.spatial.core.*
import com.meta.spatial.runtime.*
import com.meta.spatial.toolkit.*
import com.meta.spatial.vr.LocomotionSystem
import com.meta.spatial.vr.VRFeature
import org.json.JSONArray
import org.json.JSONObject

internal class WindowSlot(val id: Int, var role: String, var info: ThreadInfo? = null) {
    var isHome = role == "new"
    var header: LinearLayout? = null
    var surface: LinearLayout? = null
    var entity: Entity? = null
    var root: LinearLayout? = null
    var body: FrameLayout? = null
    var title: TextView? = null
    var status: TextView? = null
    var web: PanelWebView? = null
    var snapshot: Bitmap? = null
    var lastFocus = 0L
    var scale = 1f
    var path: String? = null
    var ready = false
    val pendingEvents = ArrayDeque<Pair<String, String?>>()
    val key get() = info?.key ?: if (isHome) "home" else role
}

class MainActivity : AppSystemActivity() {
    private val windows = mutableListOf<WindowSlot>()
    private val preferences by lazy { getSharedPreferences("quest", Context.MODE_PRIVATE) }
    private var server: String? = null
    private var pendingPairing: String? = null
    @Volatile private var sceneReady = false
    private var focused: WindowSlot? = null
    private var chooserCallback: ValueCallback<Array<Uri>>? = null
    private var lastSave = 0L
    private val performance by lazy { PerformanceProbe(this) }
    private var lastLayout = ""
    @Volatile private var liveCount = 0
    private val agents by lazy { AgentsStrip(this) }
    private var scanTarget: WindowSlot? = null
    private var cameraPermissionPending = false
    private val scanner by lazy { PairingScanner(this, { url ->
        takePairing(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        rebuildForPairing()
    }, { message -> scanTarget?.let { showStatus(it, message) } }) }
    private val voice by lazy { VoiceController(this, ::sendEvent, ::showStatus) }

    override fun registerFeatures(): List<SpatialFeature> = listOf(VRFeature(this))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = preferences.getString("server", null)?.let(PanelUrls::origin)
        takePairing(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takePairing(intent)
        if (sceneReady && pendingPairing != null) rebuildForPairing()
    }

    private fun takePairing(incoming: Intent) {
        val url = incoming.dataString
        incoming.data = null
        setIntent(Intent(this, MainActivity::class.java))
        if (url == null || !PanelUrls.isPairing(url)) return
        saveLayout()
        pendingPairing = url
        server = PanelUrls.origin(url)
        preferences.edit().putString("server", server).apply()
    }

    override fun onSceneReady() {
        super.onSceneReady()
        scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
        scene.setViewOrigin(0f, 0f, 0f, 0f)
        scene.enablePassthrough(true)
        scene.setPreferredDisplayRate(72f)
        systemManager.findSystem<LocomotionSystem>().enableLocomotion(false)
        runOnUiThread {
            sceneReady = true
            agents.create()
            if (pendingPairing != null) rebuildForPairing() else restoreWindows()
        }
    }

    override fun onSceneTick() {
        super.onSceneTick()
        val now = SystemClock.elapsedRealtime()
        if (sceneReady) performance.tick(liveCount, scene.getConfirmedFrameRate())
        if (sceneReady && now - lastSave > 2000) {
            lastSave = now
            runOnUiThread { saveLayout(); liveCount = windows.count { it.web != null }; agents.follow(windows.firstOrNull { it.isHome }) }
        }
    }

    private fun rebuildForPairing() {
        scanner.close()
        clearWindows()
        addWindow("new")
    }

    private fun restoreWindows() {
        addWindow("new")
        val saved = runCatching { JSONArray(preferences.getString(layoutKey(), "[]")) }.getOrDefault(JSONArray())
        for (index in 0 until saved.length().coerceAtMost(MAX_WINDOWS)) {
            val item = saved.optJSONObject(index) ?: continue
            if (item.optString("role") != "thread") continue
            val info = ThreadInfo.parse(item) ?: continue
            if (windows.any { it.key == info.key }) continue
            addWindow("thread", info)
        }
        windows.forEach { slot ->
            for (i in 0 until saved.length()) {
                val item = saved.optJSONObject(i) ?: continue
                if (item.optString("key") != slot.key) continue
                readPose(item)?.let { slot.entity?.setComponent(Transform(it)) }
                slot.scale = item.optDouble("scale", 1.0).toFloat().coerceIn(.7f, 1.4f)
                slot.entity?.setComponent(Scale(Vector3(slot.scale)))
            }
        }
    }

    private fun addWindow(role: String, info: ThreadInfo? = null): WindowSlot? {
        if (role == "new") windows.firstOrNull { it.isHome }?.let { focus(it); return it }
        if (windows.size >= MAX_WINDOWS) { toast("Close a panel before opening another."); return null }
        val slot = WindowSlot(View.generateViewId(), role, info)
        windows += slot
        registerPanel(ViewPanelRegistration(slot.id, { _, context -> buildWindow(slot, context) }, {
            UIPanelSettings(
                shape = QuadShapeOptions(width = WIDTH, height = HEIGHT),
                display = DpPerMeterDisplayOptions(dpPerMeter = 1000f, resolutionScale = 1.5f),
                rendering = UIPanelRenderOptions(PanelRenderMode.Layer(layerBlendType = PanelShapeLayerBlendType.ALPHA_BLEND)),
                style = PanelStyleOptions(themeResourceId = R.style.AppTheme),
            )
        }, { _, object3d, _ ->
            object3d.addInputListener(object : InputListener {
                override fun stopInput(receiver: SceneObject, sourceOfInput: Entity, downTime: Long) {
                    runOnUiThread { voice.release() }
                }
                override fun onInput(receiver: SceneObject, hitInfo: HitInfo, sourceOfInput: Entity, changed: Int, buttonState: Int, downTime: Long): Boolean {
                    val talkButton = ButtonBits.ButtonA or ButtonBits.ButtonX
                    if ((changed and talkButton) == 0) return false
                    runOnUiThread {
                        if ((buttonState and talkButton) != 0) { focus(slot); voice.press(slot) } else voice.release()
                    }
                    return true
                }
            })
        }))
        slot.entity = Entity.create(listOf(Panel(slot.id), Transform(defaultPose(windows.lastIndex)),
            Grabbable(false, GrabbableType.FACE), Scale(Vector3(1f))))
        val placements = runCatching { JSONObject(preferences.getString("placements:${server}", "{}") ?: "{}") }.getOrDefault(JSONObject())
        placements.optJSONObject(slot.key)?.let { item ->
            readPose(item)?.let { slot.entity?.setComponent(Transform(it)) }
            slot.scale = item.optDouble("scale", 1.0).toFloat().coerceIn(.7f, 1.4f)
            slot.entity?.setComponent(Scale(Vector3(slot.scale)))
        }
        agents.follow(windows.firstOrNull { it.isHome })
        if (focused !== slot) voice.cancel()
        focused = slot
        return slot
    }

    private fun defaultPose(index: Int): Pose {
        // +Z is forward in Spatial SDK. The first three chats form an arc, extras stack.
        val positions = arrayOf(
            floatArrayOf(0f, 1.25f, 1.55f, 0f),
            floatArrayOf(-1.08f, 1.25f, 1.35f, -38f),
            floatArrayOf(1.08f, 1.25f, 1.35f, 38f),
            floatArrayOf(-1.85f, 1.25f, .65f, -68f),
        )
        val point = positions[index.coerceAtMost(3)]
        val depth = (index - 3).coerceAtLeast(0) * .12f
        return Pose(Vector3(point[0], point[1] + depth * .3f, point[2] + depth), Quaternion(0f, point[3], 0f))
    }

    private fun buildWindow(slot: WindowSlot, context: Context): View {
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.TRANSPARENT)
            setPadding(6, 6, 6, 0)
        }
        slot.root = root
        val surface = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = panelSurface(context)
            clipToOutline = true
        }
        slot.surface = surface
        root.addView(surface, LinearLayout.LayoutParams(-1, 0, 1f))
        val bar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(12, 6, 12, 6)
        }
        slot.header = bar
        val title = TextView(context).apply {
            text = slot.info?.title ?: if (slot.isHome) "SSHCode" else "Overview"
            textSize = 16f; setTextColor(Color.rgb(224, 231, 227))
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(12, 0, 4, 0)
            setOnClickListener { focus(slot) }
        }
        slot.title = title
        bar.addView(title, LinearLayout.LayoutParams(0, dp(context, 44), 1f))
        if (slot.isHome) {
            panelIcon(bar, R.drawable.ic_overview, "Open Overview") { openOverview() }
            panelIcon(bar, R.drawable.ic_settings, "Server and layout settings") { settings(slot) }
        }
        panelIcon(bar, R.drawable.ic_shrink, "Smaller window") { resize(slot, -.1f) }
        panelIcon(bar, R.drawable.ic_grow, "Larger window") { resize(slot, .1f) }
        panelIcon(bar, R.drawable.ic_reload, "Reload window") { focus(slot); slot.ready = false; slot.web?.reload() }
        panelIcon(bar, R.drawable.ic_mic, "Hold to dictate, release to insert. Say send it to send.") {}.apply {
            setOnTouchListener { _, motion ->
                when (motion.actionMasked) {
                    android.view.MotionEvent.ACTION_DOWN -> { focus(slot); voice.press(slot); isPressed = true; true }
                    android.view.MotionEvent.ACTION_UP -> { voice.release(); isPressed = false; performClick(); true }
                    android.view.MotionEvent.ACTION_CANCEL -> { voice.cancel(); isPressed = false; true }
                    else -> true
                }
            }
        }
        if (!slot.isHome) panelIcon(bar, R.drawable.ic_close, "Close window") { close(slot) }
        surface.addView(bar)
        slot.body = FrameLayout(context).apply { setBackgroundColor(Color.rgb(24, 24, 24)) }
        surface.addView(slot.body, LinearLayout.LayoutParams(-1, 0, 1f))
        slot.status = TextView(context).apply {
            maxLines = 3; ellipsize = android.text.TextUtils.TruncateAt.END
            textSize = 15f; setTextColor(Color.rgb(221, 233, 226)); visibility = View.GONE
            background = panelSurface(context, 18)
            setPadding(18, 10, 18, 10)
        }
        root.addView(slot.status, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(context, 8) })
        val grab = FrameLayout(context).apply {
            contentDescription = "Move window. Select to unlock, grip or pinch to move, then select to lock."
            isFocusable = true
            setOnClickListener {
                val enabled = !(slot.entity?.getComponent<Grabbable>()?.enabled ?: false)
                slot.entity?.setComponent(Grabbable(enabled, GrabbableType.FACE))
                isSelected = enabled
                showStatus(slot, if (enabled) "Grip or pinch to move. Select the grab bar again to lock." else "")
            }
            addView(View(context).apply {
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.argb(205, 205, 216, 211)); cornerRadius = dp(context, 4).toFloat()
                }
            },
                FrameLayout.LayoutParams(dp(context, 96), dp(context, 8), android.view.Gravity.CENTER))
        }
        root.addView(grab, LinearLayout.LayoutParams(dp(context, 160), dp(context, 36)).apply { gravity = android.view.Gravity.CENTER_HORIZONTAL })
        agents.decorate(slot)
        if (server == null) showFirstRun(slot) else activate(slot)
        return root
    }

    private fun activate(slot: WindowSlot) {
        if (slot.web != null || slot.body == null || server == null) return
        while (windows.count { it.web != null } >= MAX_LIVE_WEBVIEWS) {
            val victim = windows.filter { it !== slot && it !== focused && !it.isHome && it.web != null }
                .minByOrNull { it.lastFocus } ?: break
            suspendWindow(victim)
        }
        val web = PanelWebView(slot.body!!.context, server!!,
            QuestBridge { method, json -> runOnUiThread { if (slot in windows && slot.web != null) bridge(slot, method, json) } },
            ::chooseFile,
            paired = { slot.web?.loadUrl(PanelUrls.panel(server!!, "new", feed = true)) },
            rendererGone = { slot.web = null; slot.ready = false },
            status = { message -> runOnUiThread { showStatus(slot, message) } })
        slot.web = web
        slot.ready = false
        slot.lastFocus = SystemClock.elapsedRealtime()
        slot.body!!.removeAllViews()
        slot.snapshot?.recycle(); slot.snapshot = null
        slot.body!!.addView(web, FrameLayout.LayoutParams(-1, -1))
        web.setOnTouchListener { _, event ->
            if (event.action == android.view.MotionEvent.ACTION_DOWN) { if (focused !== slot) voice.cancel(); focused = slot; slot.lastFocus = SystemClock.elapsedRealtime() }
            if (event.action == android.view.MotionEvent.ACTION_UP) web.performClick()
            false
        }
        val pairing = pendingPairing
        if (pairing != null && slot.isHome) {
            pendingPairing = null
            web.pair(pairing)
        } else web.loadUrl(PanelUrls.panel(server!!, slot.role, slot.info?.environmentId ?: "", slot.info?.threadId ?: "", feed = slot.isHome))
    }

    private fun suspendWindow(slot: WindowSlot) {
        val web = slot.web ?: return
        if (web.width > 0 && web.height > 0) {
            val scale = .5f
            slot.snapshot = Bitmap.createBitmap((web.width * scale).toInt().coerceAtLeast(1),
                (web.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.RGB_565)
            val canvas = Canvas(slot.snapshot!!); canvas.scale(scale, scale); web.draw(canvas)
        }
        slot.body?.removeAllViews()
        web.stopLoading(); web.destroy(); slot.web = null
        slot.snapshot?.let { bitmap ->
            slot.body?.addView(ImageView(slot.body!!.context).apply {
                setImageBitmap(bitmap); scaleType = ImageView.ScaleType.FIT_XY
                setOnClickListener { focus(slot) }
            }, FrameLayout.LayoutParams(-1, -1))
        }
        showStatus(slot, "Paused · tap title or snapshot to reload. Unsaved page input may need re-entry.")
    }

    private fun focus(slot: WindowSlot) {
        if (focused !== slot) voice.cancel()
        focused = slot
        slot.lastFocus = SystemClock.elapsedRealtime()
        activate(slot)
        showStatus(slot, "")
        slot.web?.requestFocus()
    }

    private fun bridge(slot: WindowSlot, method: String, json: JSONObject) {
        when (method) {
            "ready" -> {
                val role = json.optString("role")
                val path = json.optString("path")
                if (role !in listOf("overview", "thread", "new") || !path.startsWith('/') || path.startsWith("//")) return
                slot.ready = true
                while (slot.pendingEvents.isNotEmpty()) { val event = slot.pendingEvents.removeFirst(); slot.web?.event(event.first, event.second) }
                slot.path = path.substringBefore('?').substringBefore('#')
            }
            "openThread" -> ThreadInfo.parse(json)?.let(::openThread)
            "postThreads" -> if (slot.isHome) {
                val threads = json.optJSONArray("threads") ?: return
                agents.threads((0 until threads.length().coerceAtMost(40)).mapNotNull { threads.optJSONObject(it)?.let(ThreadInfo::parse) }, windows)
            }
            "panelState" -> {
                if (slot.role == "overview") return
                val info = ThreadInfo.parse(json) ?: return
                if (slot.info != null && slot.info!!.key != info.key) return
                if (slot.info == null && slot.path != PanelUrls.threadPath(info.environmentId, info.threadId)) return
                val duplicate = windows.firstOrNull { it !== slot && it.info?.key == info.key }
                if (duplicate != null) {
                    if (slot.isHome) close(duplicate) else { close(slot); focus(duplicate); return }
                }
                val wasHome = slot.isHome
                slot.role = "thread"; slot.info = info; slot.title?.text = info.title
                if (wasHome) branchHome(slot)
                agents.panelState(slot, info)
            }
        }
    }

    private fun branchHome(slot: WindowSlot) {
        val homePose = slot.entity?.getComponent<Transform>()?.transform ?: defaultPose(0)
        val homeScale = slot.scale
        slot.isHome = false
        slot.lastFocus = SystemClock.elapsedRealtime()
        slot.entity?.setComponent(Transform(defaultPose(windows.count { it !== slot && !it.isHome } + 1)))
        slot.header?.let { bar -> panelIcon(bar, R.drawable.ic_close, "Close window") { close(slot) } }
        // Keep the submitted page and any subsequent typing in the same WebView.
        slot.web?.evaluateJavascript("""
            sessionStorage.setItem('sshcodePanel','thread');
            sessionStorage.setItem('sshcodeFeed','0');
            history.replaceState(history.state,'',location.pathname);
            window.dispatchEvent(new Event('sshcode-quest-feed'));
        """.trimIndent(), null)
        if (windows.size >= MAX_WINDOWS) windows.filter { it !== slot && !it.isHome && it.web == null }
            .minByOrNull { it.lastFocus }?.let(::close)
        addWindow("new")?.let { home ->
            home.entity?.setComponent(Transform(homePose))
            home.scale = homeScale
            home.entity?.setComponent(Scale(Vector3(homeScale)))
        }
        focused = slot
        saveLayout()
    }

    internal fun openOverview() {
        windows.firstOrNull { it.role == "overview" }?.let { focus(it); return }
        addWindow("overview")
    }

    internal fun openThread(info: ThreadInfo) {
        val existing = windows.firstOrNull { it.info?.key == info.key }
        if (existing != null) focus(existing) else addWindow("thread", info)
    }

    private fun sendEvent(slot: WindowSlot, type: String, text: String?) {
        if (slot !in windows) return
        focus(slot)
        if (slot.ready) slot.web?.event(type, text)
        else if (slot.pendingEvents.size < 8) slot.pendingEvents.addLast(type to text)
    }
    private fun resize(slot: WindowSlot, delta: Float) {
        slot.scale = (slot.scale + delta).coerceIn(.7f, 1.4f)
        slot.entity?.setComponent(Scale(Vector3(slot.scale)))
        saveLayout()
    }
    private fun close(slot: WindowSlot) {
        if (slot.isHome) return
        saveLayout()
        dispose(slot)
        windows.remove(slot)
        if (focused === slot) focused = windows.firstOrNull()
        saveLayout()
    }
    private fun dispose(slot: WindowSlot) {
        voice.cancelFor(slot)
        agents.removed(slot)
        slot.web?.stopLoading(); slot.web?.destroy(); slot.web = null
        slot.snapshot?.recycle(); slot.snapshot = null
        slot.entity?.destroy(); slot.entity = null
        panelRegistrations.remove(slot.id)
    }
    private fun clearWindows() { windows.toList().forEach(::dispose); windows.clear(); focused = null; agents.reset(); lastLayout = "" }

    private fun showFirstRun(slot: WindowSlot) {
        val column = LinearLayout(slot.body!!.context).apply {
            orientation = LinearLayout.VERTICAL; setPadding(32, 36, 32, 24)
        }
        label(column, "SSHCode at your desk", 28f)
        label(column, "Create a pairing link on your SSHCode server, then open it on this headset.\n\nFrom your Mac, use the pairing script in apps/quest. The same login is shared by every panel.\n\nConnect to a server below if this headset is already paired.", 20f)
        button(column, "Scan pairing QR") { scanPairing(slot) }
        button(column, "Server settings") { settings(slot) }
        slot.body!!.removeAllViews(); slot.body!!.addView(column)
    }

    private fun settings(slot: WindowSlot) {
        val context = slot.body!!.context
        val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        label(column, "SSHCode settings", 26f)
        label(column, "Server address", 18f)
        val address = EditText(context).apply {
            setText(server ?: ""); hint = "http://your-server:3773"; setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
        }
        column.addView(address)
        button(column, "Connect") {
            val input = address.text.toString().trim()
            val origin = PanelUrls.origin(input)
            if (origin == null || Uri.parse(input).fragment != null) { toast("Enter an http or https server address without a pairing token."); return@button }
            saveLayout(); server = origin; preferences.edit().putString("server", origin).apply()
            clearWindows(); restoreWindows()
        }
        button(column, "Scan pairing QR / stop scanning") { scanPairing(slot) }
        button(column, "Reset layout here") { resetLayout(); toast("Layout reset to your current gaze.") }
        button(column, "Re-pair / forget server") {
            saveLayout(); server = null
            preferences.edit().remove("server").apply()
            CookieManager.getInstance().removeAllCookies(null); CookieManager.getInstance().flush()
            clearWindows(); addWindow("new")
        }
        button(column, "Back") { slot.body!!.removeAllViews(); if (server == null) showFirstRun(slot) else { slot.web?.let { slot.body!!.addView(it) } ?: activate(slot) } }
        slot.web?.let { (it.parent as? FrameLayout)?.removeView(it) }
        slot.body!!.removeAllViews(); slot.body!!.addView(column)
    }
    private fun scanPairing(slot: WindowSlot) {
        if (scanner.isScanning) { scanner.close(); showStatus(slot, "Scanner stopped."); return }
        scanTarget = slot
        if (checkSelfPermission(PairingScanner.PERMISSION) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            cameraPermissionPending = true
            requestPermissions(arrayOf(PairingScanner.PERMISSION), PairingScanner.PERMISSION_REQUEST)
        } else scanner.start()
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == VoiceController.PERMISSION_REQUEST) voice.permissionResult(grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED)
        if (requestCode == PairingScanner.PERMISSION_REQUEST && cameraPermissionPending) {
            cameraPermissionPending = false
            if (grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) scanner.start()
            else scanTarget?.let { showStatus(it, "Camera permission was declined. Use the Mac pairing helper.") }
        }
    }
    private fun resetLayout() {
        // Room tracking is relative to LOCAL_FLOOR. A reset aligns the arc to the current gaze.
        val viewer = scene.getViewerPose()
        val centre = viewer.removePitchAndRoll()
        windows.forEachIndexed { index, slot ->
            val relative = defaultPose(index)
            relative.t.y = 0f
            slot.entity?.setComponent(Transform(centre * relative))
            slot.scale = 1f; slot.entity?.setComponent(Scale(Vector3(1f)))
        }
        saveLayout()
    }

    private fun layoutKey() = "layout:${server ?: "unpaired"}"
    private fun saveLayout() {
        if (!sceneReady) return
        val array = JSONArray()
        val placements = runCatching { JSONObject(preferences.getString("placements:${server}", "{}") ?: "{}") }.getOrDefault(JSONObject())
        windows.forEach { slot ->
            val pose = slot.entity?.getComponent<Transform>()?.transform ?: return@forEach
            val info = slot.info
            val item = JSONObject().put("key", slot.key).put("role", slot.role)
                .put("environmentId", info?.environmentId).put("threadId", info?.threadId)
                .put("title", info?.title).put("harness", info?.harness).put("state", info?.state)
                .put("needsUser", info?.needsUser ?: false).put("scale", slot.scale)
                .put("pose", JSONArray(listOf(pose.t.x, pose.t.y, pose.t.z, pose.q.w, pose.q.x, pose.q.y, pose.q.z)))
            array.put(item)
            placements.put(slot.key, item)
        }
        val value = array.toString()
        if (value != lastLayout) { preferences.edit().putString(layoutKey(), value).putString("placements:${server}", placements.toString()).apply(); lastLayout = value }
    }
    private fun readPose(json: JSONObject): Pose? = runCatching {
        val values = json.getJSONArray("pose")
        val f = (0..6).map { values.getDouble(it).toFloat().also { n -> require(n.isFinite()) } }
        Pose(Vector3(f[0], f[1], f[2]), Quaternion(f[3], f[4], f[5], f[6]))
    }.getOrNull()

    private fun chooseFile(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        chooserCallback?.onReceiveValue(null)
        chooserCallback = callback
        return runCatching { startActivityForResult(params.createIntent(), FILE_REQUEST); true }
            .getOrElse { chooserCallback = null; callback.onReceiveValue(null); toast("No file picker is available."); true }
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_REQUEST) {
            chooserCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            chooserCallback = null
        }
    }
    override fun onPause() {
        saveLayout()
        voice.cancel()
        scanner.close()
        windows.forEach { it.web?.onPause() }
        CookieManager.getInstance().flush()
        super.onPause()
    }
    override fun onResume() { super.onResume(); windows.forEach { it.web?.onResume() } }
    override fun onDestroy() {
        sceneReady = false
        chooserCallback?.onReceiveValue(null); chooserCallback = null
        clearWindows()
        agents.destroy()
        voice.close()
        scanner.close()
        performance.close()
        super.onDestroy()
    }
    private fun showStatus(slot: WindowSlot, message: String) {
        slot.status?.text = message; slot.status?.visibility = if (message.isBlank()) View.GONE else View.VISIBLE
    }
    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    private fun button(parent: LinearLayout, title: String, action: (Button) -> Unit): Button = Button(parent.context).apply {
        text = title; textSize = 13f; minHeight = dp(context, 44); minimumWidth = dp(context, 44)
        setPadding(dp(context, 8), 0, dp(context, 8), 0)
        setOnClickListener { action(this) }; parent.addView(this)
    }
    private fun label(parent: LinearLayout, value: String, size: Float) = TextView(parent.context).apply {
        text = value; textSize = size; setTextColor(Color.WHITE); setPadding(0, 8, 0, 12); parent.addView(this)
    }
    private fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density).toInt()
    companion object {
        private const val WIDTH = 1.15f
        private const val HEIGHT = .83f
        private const val MAX_WINDOWS = 12
        private const val MAX_LIVE_WEBVIEWS = 4
        private const val FILE_REQUEST = 20
    }
}
