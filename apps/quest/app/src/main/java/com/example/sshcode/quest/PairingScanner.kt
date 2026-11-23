package com.example.sshcode.quest

import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.*
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/** Passthrough camera frames and QR contents stay in memory and are never logged or saved. */
internal class PairingScanner(private val activity: Activity, private val found: (String) -> Unit, private val status: (String) -> Unit) {
    private class ScanRun {
        val worker = HandlerThread("SSHCodeQr").apply { start() }
        val handler = Handler(worker.looper)
        val active = AtomicBoolean(true)
        var camera: CameraDevice? = null
        var reader: ImageReader? = null
        var session: CameraCaptureSession? = null
        var lastDecode = 0L
    }
    @Volatile private var current: ScanRun? = null
    val isScanning get() = current?.active?.get() == true

    @SuppressLint("MissingPermission")
    fun start() {
        if (isScanning) return
        if (activity.checkSelfPermission(PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            status("Camera permission is needed to scan a pairing QR."); return
        }
        val run = ScanRun()
        current = run
        run.handler.post {
            runCatching {
                val manager = activity.getSystemService(CameraManager::class.java)
                val source = CameraCharacteristics.Key("com.meta.extra_metadata.camera_source", Int::class.java)
                val position = CameraCharacteristics.Key("com.meta.extra_metadata.position", Int::class.java)
                // Never select an avatar/virtual camera as a fallback.
                val cameras = manager.cameraIdList.mapNotNull { id ->
                    val data = manager.getCameraCharacteristics(id)
                    if (data.get(source) == 0) id to data else null
                }.sortedBy { it.second.get(position) ?: 2 }
                val (id, data) = cameras.firstOrNull() ?: error("No passthrough camera")
                val sizes = data.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                    ?.getOutputSizes(ImageFormat.YUV_420_888).orEmpty()
                val size = sizes.filter { it.width <= 1280 }.maxByOrNull { it.width * it.height }
                    ?: sizes.minByOrNull { it.width * it.height } ?: error("No camera output")
                val decoder = MultiFormatReader().apply { setHints(mapOf(
                    DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                    DecodeHintType.TRY_HARDER to true,
                    DecodeHintType.ALSO_INVERTED to true,
                )) }
                val images = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 2)
                run.reader = images
                images.setOnImageAvailableListener({ available ->
                    val image = available.acquireLatestImage() ?: return@setOnImageAvailableListener
                    runCatching { image.use {
                        val now = SystemClock.elapsedRealtime()
                        if (!run.active.get() || now - run.lastDecode < 350) return@use
                        run.lastDecode = now
                        val crop = image.cropRect
                        val plane = image.planes[0]
                        val pixels = copyLuminance(plane.buffer, plane.rowStride, plane.pixelStride,
                            crop.left, crop.top, crop.width(), crop.height())
                        val luminance = PlanarYUVLuminanceSource(pixels, crop.width(), crop.height(), 0, 0, crop.width(), crop.height(), false)
                        val result = runCatching { decoder.decodeWithState(BinaryBitmap(HybridBinarizer(luminance))) }.getOrNull()
                        decoder.reset()
                        val url = result?.text ?: return@use
                        if (PanelUrls.isPairing(url) && run.active.compareAndSet(true, false)) {
                            close()
                            activity.runOnUiThread { found(url) }
                        }
                    } }.onFailure { fail(run) }
                }, run.handler)
                manager.openCamera(id, activity.mainExecutor, object : CameraDevice.StateCallback() {
                    override fun onOpened(device: CameraDevice) {
                        if (!run.active.get()) { device.close(); return }
                        run.camera = device
                        runCatching { device.createCaptureSession(SessionConfiguration(SessionConfiguration.SESSION_REGULAR,
                            listOf(OutputConfiguration(images.surface)), activity.mainExecutor,
                            object : CameraCaptureSession.StateCallback() {
                            override fun onConfigured(configured: CameraCaptureSession) {
                                if (!run.active.get()) { configured.close(); return }
                                run.session = configured
                                runCatching {
                                    val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply { addTarget(images.surface) }
                                    configured.setRepeatingRequest(request.build(), null, run.handler)
                                    activity.runOnUiThread { status("Scanning · look at the pairing QR on your screen. Camera frames stay on this headset.") }
                                }.onFailure { fail(run) }
                            }
                            override fun onConfigureFailed(failed: CameraCaptureSession) { failed.close(); fail(run) }
                        })) }.onFailure { fail(run) }
                    }
                    override fun onDisconnected(device: CameraDevice) { device.close(); fail(run) }
                    override fun onError(device: CameraDevice, error: Int) { device.close(); fail(run) }
                })
            }.onFailure { fail(run) }
        }
    }
    private fun fail(run: ScanRun) {
        if (current !== run) return
        close()
        activity.runOnUiThread { status("Could not open the passthrough camera. Use the Mac pairing helper instead.") }
    }
    fun close() {
        val run = current ?: return
        current = null
        run.active.set(false)
        run.handler.post {
            runCatching { run.session?.stopRepeating() }
            run.session?.close(); run.camera?.close(); run.reader?.close()
            run.worker.quitSafely()
        }
    }
    companion object {
        const val PERMISSION = "horizonos.permission.HEADSET_CAMERA"
        const val PERMISSION_REQUEST = 40
    }
}

internal fun copyLuminance(buffer: ByteBuffer, rowStride: Int, pixelStride: Int, left: Int, top: Int, width: Int, height: Int): ByteArray {
    val result = ByteArray(width * height)
    val offset = buffer.position()
    for (y in 0 until height) for (x in 0 until width) {
        result[y * width + x] = buffer.get(offset + (top + y) * rowStride + (left + x) * pixelStride)
    }
    return result
}
