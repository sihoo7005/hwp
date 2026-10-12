package com.sihoo.hwp

import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OriginalRenderingTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun rendersObjectsThroughJniAndNativeCanvas() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val previews = File(context.filesDir, "visual-checks").apply { mkdirs() }
        for (name in listOf("sample.hwp", "sample.hwpx", "sample3.hwp", "equation.hwpx", "image.hwpx", "table.hwpx", "shapes.hwp", "chart.hwp", "chart.hwpx")) {
            val bytes = instrumentation.context.assets.open("fixtures/$name").use { it.readBytes() }
            val document = NativeReader.open(bytes, FontStore.prepare(context), File(context.cacheDir, "instrumented-pages"))
            try {
                val page = NativeReader.page(document.id, 0)
                val drawing = loadCanvasPage(page.file)
                val bitmap = Bitmap.createBitmap(900, (900 * drawing.height / drawing.width).toInt(), Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(android.graphics.Color.WHITE)
                android.graphics.Canvas(bitmap).apply {
                    scale(900 / drawing.width, 900 / drawing.width)
                    drawPicture(drawing.picture)
                }
                try {
                    val pixels = IntArray(bitmap.width * bitmap.height)
                    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
                    assertTrue("$name must have visible content", pixels.count { (it and 0xFFFFFF) < 0xF5F5F5 } > 100)
                    if (name.startsWith("chart.")) {
                        assertTrue("$name must draw chart series on Android Canvas", pixels.count {
                            val red = (it shr 16) and 255
                            val green = (it shr 8) and 255
                            val blue = it and 255
                            maxOf(red, green, blue) - minOf(red, green, blue) > 30
                        } > 50)
                    }
                    File(previews, "$name-page.png").outputStream().use {
                        bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                } finally { bitmap.recycle() }

                compose.runOnUiThread {
                    compose.activity.setContent {
                        MaterialTheme {
                            var zoom by remember { mutableFloatStateOf(1f) }
                            PageViewer(document, 0, zoom, false, { zoom = it }, Modifier.fillMaxSize())
                        }
                    }
                }
                compose.waitUntil(30_000) {
                    compose.onAllNodesWithContentDescription("1쪽 원본 서식").fetchSemanticsNodes().isNotEmpty()
                }
                compose.onNodeWithContentDescription("1쪽 원본 서식").assertIsDisplayed()
                val screenshot = compose.onRoot().captureToImage().asAndroidBitmap()
                val screenPixels = IntArray(screenshot.width * screenshot.height)
                screenshot.getPixels(screenPixels, 0, screenshot.width, 0, 0, screenshot.width, screenshot.height)
                assertTrue("$name must paint content in the Compose viewport",
                    screenPixels.count { (it and 0xFFFFFF) < 0xC0C0C0 } > 100)
                if (name.startsWith("chart.")) {
                    assertTrue("$name chart must appear in the GPU-backed Compose Canvas", screenPixels.count {
                        val red = (it shr 16) and 255
                        val green = (it shr 8) and 255
                        val blue = it and 255
                        maxOf(red, green, blue) - minOf(red, green, blue) > 30
                    } > 50)
                }
                File(previews, "$name-screen.png").outputStream().use {
                    screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)
                }
                compose.runOnUiThread { compose.activity.setContent { Text("검증 완료") } }
            } finally { NativeReader.close(document.id) }
        }
    }
}
