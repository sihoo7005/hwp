package com.sihoo.hwp

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import java.io.File
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

internal fun rasterizePage(file: File, desiredWidth: Int): Bitmap {
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { renderer ->
            check(renderer.pageCount == 1) { "쪽별 표시 파일이 올바르지 않습니다." }
            renderer.openPage(0).use { page ->
                var width = desiredWidth.coerceIn(256, 4096)
                var height = (width.toDouble() * page.height / page.width).toInt().coerceAtLeast(1)
                val pixels = width.toLong() * height
                if (pixels > 8_000_000) {
                    val factor = sqrt(8_000_000.0 / pixels)
                    width = (width * factor).toInt().coerceAtLeast(1)
                    height = (height * factor).toInt().coerceAtLeast(1)
                }
                return Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also {
                    it.eraseColor(AndroidColor.WHITE)
                    page.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                }
            }
        }
    }
}
@Composable
fun PageViewer(document: ReadDocument, index: Int, zoom: Float, textMode: Boolean,
    onZoom: (Float) -> Unit, modifier: Modifier = Modifier) {
    var attempt by remember { mutableIntStateOf(0) }
    val page by produceState<Result<RenderedPage>?>(null, document.id, index, attempt) {
        value = null
        value = try { Result.success(withContext(Dispatchers.IO) { NativeReader.page(document.id, index) }) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { Result.failure(error) }
    }
    var pan by remember { mutableStateOf(Offset.Zero) }
    val transform = rememberTransformableState { change, offset, _ ->
        onZoom((zoom * change).coerceIn(1f, 5f))
        pan = if (zoom <= 1f) Offset.Zero else pan + offset
    }
    BoxWithConstraints(modifier.clipToBounds().background(Color(0xFFE5E8EF))) {
        val width = with(LocalDensity.current) { maxWidth.roundToPx() }
        val content = page?.getOrNull()
        if (content == null) {
            Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                if (page == null) CircularProgressIndicator()
                else {
                    Text(page?.exceptionOrNull()?.message ?: "이 쪽을 표시하지 못했습니다.")
                    TextButton(onClick = { attempt++ }) { Text("다시 그리기") }
                }
            }
        } else if (textMode) {
            Column(Modifier.fillMaxSize().background(Color.White)
                .verticalScroll(rememberScrollState()).padding(20.dp)) {
                SelectionContainer { Text(content.text.ifBlank { "추출할 텍스트가 없습니다." }) }
            }
        } else {
            val bitmap by produceState<Result<Bitmap>?>(null, content.file, width, zoom) {
                delay(150)
                value = try {
                    Result.success(withContext(Dispatchers.IO) { rasterizePage(content.file, (width * zoom).toInt()) })
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { Result.failure(error) }
            }
            Box(Modifier.fillMaxSize().transformable(transform).clipToBounds(), contentAlignment = Alignment.Center) {
                val image = bitmap?.getOrNull()
                if (image != null) {
                    val maxX = width * (zoom - 1f) / 2
                    val maxY = with(LocalDensity.current) { maxHeight.toPx() } * (zoom - 1f) / 2
                    Image(image.asImageBitmap(), "${index + 1}쪽 원본 서식",
                        Modifier.fillMaxSize().graphicsLayer {
                            scaleX = zoom; scaleY = zoom
                            translationX = pan.x.coerceIn(-maxX, maxX)
                            translationY = pan.y.coerceIn(-maxY, maxY)
                        })
                } else if (bitmap == null) CircularProgressIndicator()
                else Text(bitmap?.exceptionOrNull()?.message ?: "페이지를 그리지 못했습니다.")
            }
        }
        if (content?.warnings?.isNotEmpty() == true) {
            Text(content.warnings.joinToString("\n"),
                Modifier.align(Alignment.BottomCenter).background(Color.White).padding(8.dp),
                color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
    }
}
