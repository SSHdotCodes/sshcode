package com.example.sshcode.quest

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeWriter

class PairingScannerTest {
    @Test fun cameraPlaneCopyHonorsCropRowPaddingAndPixelStride() {
        val buffer = ByteBuffer.wrap(byteArrayOf(9, 1, 9, 2, 9, 3, 9, 8, 9, 4, 9, 5, 9, 6, 9, 8))
        buffer.position(1)
        assertArrayEquals(byteArrayOf(2, 3, 5, 6), copyLuminance(buffer, 8, 2, 1, 0, 2, 2))
    }
    @Test fun zxingDecodesPairingQrFromLuminanceWithoutPlayServices() {
        val url = "http://localhost:3997/pair#token=synthetic-test-only"
        val matrix = QRCodeWriter().encode(url, BarcodeFormat.QR_CODE, 320, 320)
        val pixels = ByteArray(320 * 320) { i -> if (matrix.get(i % 320, i / 320)) 0 else 255.toByte() }
        val source = PlanarYUVLuminanceSource(pixels, 320, 320, 0, 0, 320, 320, false)
        val result = MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(source)))
        assertEquals(url, result.text)
        assertTrue(PanelUrls.isPairing(result.text))
    }
}
