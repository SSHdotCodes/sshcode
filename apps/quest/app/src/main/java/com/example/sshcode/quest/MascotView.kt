package com.example.sshcode.quest

import android.content.Context
import android.graphics.*
import android.os.SystemClock
import android.util.LruCache
import android.view.View
import org.json.JSONArray
import org.json.JSONObject

/** Sprites and timings come from the same generated manifest used by the web UI. */
internal class MascotView(context: Context) : View(context) {
    private val paint = Paint()
    private val source = Rect()
    private val destination = RectF()
    private var info: ThreadInfo? = null
    private var animation: JSONObject? = null
    private var sheet: Bitmap? = null
    private var durations = doubleArrayOf()
    private var startedAt = 0L
    private var waving = false
    private var animate = true
    private var waveUntil = 0L

    fun show(info: ThreadInfo?, wave: Boolean = false, animated: Boolean = true) {
        val changed = this.info?.harness != info?.harness || this.info?.state != info?.state
        this.info = info
        animate = animated
        if (changed || wave || animation == null) select(wave)
        invalidate()
    }
    private fun select(wave: Boolean) {
        waving = wave
        val harness = info?.harness ?: run { sheet = null; animation = null; return }
        val state = if (wave) "greet" else info!!.state
        val variants = manifest(context).optJSONObject(harness)?.optJSONArray(state) ?: JSONArray()
        // The primary variant is the quietest consistent representation on a desk.
        animation = variants.optJSONObject(0)
        val data = animation ?: return
        val file = data.getString("file")
        sheet = sheets.get(file) ?: context.assets.open("mascots/$file").use { BitmapFactory.decodeStream(it) }?.also { sheets.put(file, it) }
        val timing = data.getJSONArray("durations")
        durations = DoubleArray(timing.length()) { timing.getDouble(it) }
        startedAt = SystemClock.uptimeMillis()
        if (wave) waveUntil = startedAt + durations.sum().toLong()
    }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val bitmap = sheet ?: return
        val data = animation ?: return
        if (durations.isEmpty()) return
        val now = SystemClock.uptimeMillis()
        if (waving && now >= waveUntil) { select(false); invalidate(); return }
        val period = durations.sum().coerceAtLeast(1.0)
        val elapsed = (now - startedAt).toDouble()
        val finiteRepeats = if (data.isNull("repeats")) null else data.optInt("repeats", 1)
        val state = info?.state
        // Idle sprites rest after one cycle. Other states use the source repeat count.
        val repeats = if (state == "idle" && !waving) 1 else finiteRepeats
        val finished = !animate || (repeats != null && elapsed >= period * repeats)
        var phase = if (finished) 0.0 else elapsed % period
        var frame = 0
        while (frame < durations.lastIndex && phase >= durations[frame]) { phase -= durations[frame]; frame++ }
        val columns = data.getInt("columns")
        val rows = data.getInt("rows")
        val cellWidth = bitmap.width / columns
        val cellHeight = bitmap.height / rows
        source.set(frame % columns * cellWidth, frame / columns * cellHeight,
            (frame % columns + 1) * cellWidth, (frame / columns + 1) * cellHeight)
        val size = minOf(width, height).toFloat()
        destination.set((width - size) / 2f, height - size, (width + size) / 2f, height.toFloat())
        paint.isFilterBitmap = data.isNull("pixelSize") // Clawd keeps nearest-neighbour pixels.
        canvas.drawBitmap(bitmap, source, destination, paint)
        if (!finished && isShown) postInvalidateDelayed((durations[frame] - phase).toLong().coerceAtLeast(16))
    }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); invalidate() }
    companion object {
        private var sourceManifest: JSONObject? = null
        private fun manifest(context: Context): JSONObject = sourceManifest ?: context.assets.open("mascots/manifest.json")
            .bufferedReader().use { JSONObject(it.readText()) }.also { sourceManifest = it }
        private val sheets = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
            override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
        }
    }
}
