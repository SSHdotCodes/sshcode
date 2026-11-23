package com.example.sshcode.quest

import android.content.Context
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log

/** Tick frequency is a CPU-side signal, not compositor FPS. Never logs URLs or chat text. */
internal class PerformanceProbe(context: Context) {
    private val power = context.getSystemService(PowerManager::class.java)
    private var start = SystemClock.elapsedRealtime()
    private var ticks = 0
    private val sampler = java.util.concurrent.Executors.newSingleThreadExecutor()
    fun tick(liveWebViews: Int, refreshHz: Float) {
        ticks++
        val now = SystemClock.elapsedRealtime()
        if (now - start < 30_000) return
        val frequency = ticks * 1000.0 / (now - start)
        runCatching { sampler.execute {
            Log.i("SSHCodeQuest", "live=$liveWebViews appPssKiB=${Debug.getPss()} sceneTickHz=${"%.1f".format(frequency)} displayHz=$refreshHz thermal=${power.currentThermalStatus}")
        } }
        ticks = 0; start = now
    }
    fun close() = sampler.shutdown()
}
