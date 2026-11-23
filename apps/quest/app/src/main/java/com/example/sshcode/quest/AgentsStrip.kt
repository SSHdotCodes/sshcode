package com.example.sshcode.quest

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.*
import com.meta.spatial.core.*
import com.meta.spatial.runtime.SceneAudioAsset
import com.meta.spatial.runtime.PanelShapeLayerBlendType
import com.meta.spatial.toolkit.*
import org.json.JSONArray
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.*

/** One compact panel above Home, with static chip sprites and a scrolling row of static chips. */
internal class AgentsStrip(private val activity: MainActivity) {
    private val attention = mutableMapOf<String, Boolean>()
    private val mascots = mutableMapOf<Int, MascotView>()
    private var latest = emptyList<ThreadInfo>()
    private var strip: LinearLayout? = null
    private var entity: Entity? = null
    private val id = View.generateViewId()
    private var sound: SceneAudioAsset? = null

    fun create() {
        if (entity != null) return
        activity.registerPanel(ViewPanelRegistration(id, { _, context ->
            LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL; setPadding(8, 6, 8, 6)
                background = panelSurface(context, 32); clipToOutline = true; strip = this; render()
            }
        }, { UIPanelSettings(shape = QuadShapeOptions(width = 1.15f, height = .11f),
            display = DpPerMeterDisplayOptions(dpPerMeter = 1000f, resolutionScale = 1.5f),
            rendering = UIPanelRenderOptions(PanelRenderMode.Layer(layerBlendType = PanelShapeLayerBlendType.ALPHA_BLEND)),
            style = PanelStyleOptions(themeResourceId = R.style.AppTheme)) }))
        entity = Entity.create(listOf(Panel(id), Transform(Pose(Vector3(0f, 1.78f, 1.55f)))))
        sound = runCatching { SceneAudioAsset.loadLocalFile(softChime(activity).absolutePath) }.getOrNull()
    }
    fun follow(home: WindowSlot?) {
        val parent = home?.entity ?: return
        entity?.setComponent(TransformParent(parent))
        entity?.setComponent(Transform(Pose(Vector3(0f, .53f * home.scale, 0f))))
    }
    fun decorate(slot: WindowSlot) {
        if (slot.role != "thread" || mascots.containsKey(slot.id)) return
        val root = slot.header ?: return
        val holder = FrameLayout(root.context)
        holder.setBackgroundColor(Color.TRANSPARENT)
        val mascot = MascotView(root.context)
        val size = dp(root.context, 36)
        holder.addView(mascot, FrameLayout.LayoutParams(size, size, Gravity.CENTER))
        root.addView(holder, 0, LinearLayout.LayoutParams(size, size))
        mascots[slot.id] = mascot
        mascot.show(slot.info)
    }
    fun panelState(slot: WindowSlot, info: ThreadInfo) {
        decorate(slot)
        val transition = transition(info)
        mascots[slot.id]?.show(info, wave = transition)
        if (transition) signal(slot)
    }
    fun threads(threads: List<ThreadInfo>, windows: List<WindowSlot>) {
        latest = threads
        threads.forEach { info ->
            if (transition(info)) {
                val slot = windows.firstOrNull { it.info?.key == info.key }
                if (slot != null) { mascots[slot.id]?.show(info, wave = true); signal(slot) }
                else chime(entity)
            }
        }
        // Keep transition memory bounded when chats leave the active snapshot.
        val keys = threads.map { it.key }.toSet() + windows.mapNotNull { it.info?.key }
        attention.keys.retainAll(keys)
        render()
    }
    private fun transition(info: ThreadInfo): Boolean {
        val previous = attention.put(info.key, info.needsUser)
        // Treat the initial snapshot as an established state, avoiding an alert storm on launch.
        return previous == false && info.needsUser
    }
    private fun render() {
        val target = strip ?: return
        target.removeAllViews()
        val scroll = HorizontalScrollView(target.context)
        val row = LinearLayout(target.context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        panelIcon(row, R.drawable.ic_overview, "Open Overview") { activity.openOverview() }
        if (latest.isEmpty()) row.addView(TextView(target.context).apply { text = "Agents · active chats appear here"; textSize = 17f; setTextColor(Color.LTGRAY); setPadding(12, 12, 12, 12) })
        latest.take(40).forEach { info ->
            val chip = LinearLayout(target.context).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                setPadding(8, 6, 12, 6)
                background = GradientDrawable().apply {
                    setColor(if (info.needsUser) Color.rgb(50, 62, 48) else Color.rgb(28, 38, 33))
                    cornerRadius = dp(context, 36).toFloat()
                    setStroke(1, if (info.needsUser) Color.rgb(192, 194, 130) else Color.argb(55, 220, 235, 228))
                }
                setOnClickListener { activity.openThread(info) }
                contentDescription = "${info.title}, ${info.state}${if (info.needsUser) ", needs you" else ""}"
            }
            val size = dp(target.context, 40)
            chip.addView(MascotView(target.context).apply { show(info, animated = false) }, LinearLayout.LayoutParams(size, size))
            chip.addView(TextView(target.context).apply {
                text = info.title.take(30) + "\n" + if (info.needsUser) "Needs you" else info.state.replaceFirstChar(Char::uppercase)
                textSize = 14f; setTextColor(Color.WHITE)
            })
            row.addView(chip, LinearLayout.LayoutParams(dp(target.context, 220), dp(target.context, 72)).apply { marginEnd = 8 })
        }
        scroll.addView(row); target.addView(scroll)
    }
    private fun signal(slot: WindowSlot) {
        val root = slot.surface ?: return
        root.background = panelSurface(root.context, attention = true)
        root.postDelayed({ root.background = panelSurface(root.context) }, 1600)
        chime(slot.entity)
    }
    private fun chime(source: Entity?) {
        val asset = sound ?: return
        if (source != null) activity.scene.playSound(asset, source, .12f)
    }
    fun reset() { latest = emptyList(); attention.clear(); render() }
    fun removed(slot: WindowSlot) { mascots.remove(slot.id) }
    fun destroy() {
        entity?.destroy(); entity = null; strip = null
        sound?.destroy(); sound = null
        activity.panelRegistrations.remove(id)
        mascots.clear(); attention.clear()
    }
    private fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density).toInt()

    companion object {
        /** A short, locally synthesized chime needs neither a media asset nor a speech service. */
        private fun softChime(context: Context): File {
            val file = File(context.cacheDir, "attention.wav")
            if (file.exists()) return file
            val rate = 24000
            val samples = rate / 3
            val data = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN)
            data.put("RIFF".toByteArray()).putInt(36 + samples * 2).put("WAVEfmt ".toByteArray())
            data.putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
            data.put("data".toByteArray()).putInt(samples * 2)
            for (i in 0 until samples) {
                val time = i.toDouble() / rate
                val envelope = minOf(time / .025, 1.0) * exp(-time * 13)
                val sample = (sin(2 * PI * 660 * time) + .3 * sin(2 * PI * 990 * time)) * envelope * 6000
                data.putShort(sample.toInt().toShort())
            }
            file.writeBytes(data.array())
            return file
        }
    }
}
