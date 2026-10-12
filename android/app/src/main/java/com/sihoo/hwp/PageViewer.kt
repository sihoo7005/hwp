package com.sihoo.hwp

import android.graphics.Picture
import android.graphics.RectF
import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.caverock.androidsvg.SVG
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal data class CanvasPage(val picture: Picture) {
    val width get() = picture.width.toFloat()
    val height get() = picture.height.toFloat()
}

internal fun loadCanvasPage(file: File): CanvasPage {
    val svg = file.inputStream().use { SVG.getFromInputStream(it) }
    check(svg.documentWidth.isFinite() && svg.documentHeight.isFinite() &&
        svg.documentWidth in 1f..100_000f && svg.documentHeight in 1f..100_000f) {
        "쪽의 크기가 올바르지 않습니다."
    }
    // Record native drawing commands once; zoom replays vectors, not a page bitmap.
    return CanvasPage(svg.renderToPicture())
}

@Composable
fun PageViewer(document: ReadDocument, index: Int, zoom: Float, textMode: Boolean,
    onZoom: (Float) -> Unit, modifier: Modifier = Modifier) {
    var attempt by remember(document.id, index) { mutableIntStateOf(0) }
    val page by produceState<Result<RenderedPage>?>(null, document.id, index, attempt) {
        value = null
        value = try { Result.success(withContext(Dispatchers.IO) { NativeReader.page(document.id, index) }) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { Result.failure(error) }
    }
    var pan by remember(document.id, index) { mutableStateOf(Offset.Zero) }
    BoxWithConstraints(modifier.clipToBounds().background(Color(0xFFE5E8EF))) {
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
            val drawing by produceState<Result<CanvasPage>?>(null, content.file, attempt) {
                value = null
                value = try {
                    Result.success(withContext(Dispatchers.Default) { loadCanvasPage(content.file) })
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { Result.failure(error) }
            }
            val rendered = drawing?.getOrNull()
            if (rendered != null) {
                val viewportWidth = with(LocalDensity.current) { maxWidth.toPx() }
                val viewportHeight = with(LocalDensity.current) { maxHeight.toPx() }
                val fit = min(viewportWidth / rendered.width, viewportHeight / rendered.height)
                val scale = fit * zoom
                val maxX = max((rendered.width * scale - viewportWidth) / 2, 0f)
                val maxY = max((rendered.height * scale - viewportHeight) / 2, 0f)
                val transform = rememberTransformableState { change, offset, _ ->
                    val nextZoom = (zoom * change).coerceIn(1f, 5f)
                    val nextScale = fit * nextZoom
                    onZoom(nextZoom)
                    pan = Offset(
                        (pan.x + offset.x).coerceIn(-max((rendered.width * nextScale - viewportWidth) / 2, 0f),
                            max((rendered.width * nextScale - viewportWidth) / 2, 0f)),
                        (pan.y + offset.y).coerceIn(-max((rendered.height * nextScale - viewportHeight) / 2, 0f),
                            max((rendered.height * nextScale - viewportHeight) / 2, 0f)))
                }
                LaunchedEffect(zoom) { pan = Offset(pan.x.coerceIn(-maxX, maxX), pan.y.coerceIn(-maxY, maxY)) }
                Canvas(Modifier.fillMaxSize().transformable(transform).semantics {
                    contentDescription = "${index + 1}쪽 원본 서식"
                }) {
                    val x = (size.width - rendered.width * scale) / 2 + pan.x.coerceIn(-maxX, maxX)
                    val y = (size.height - rendered.height * scale) / 2 + pan.y.coerceIn(-maxY, maxY)
                    drawIntoCanvas { canvas ->
                        val native = canvas.nativeCanvas
                        native.save()
                        try {
                            native.translate(x, y)
                            native.scale(scale, scale)
                            native.drawRect(RectF(0f, 0f, rendered.width, rendered.height),
                                android.graphics.Paint().apply { color = android.graphics.Color.WHITE })
                            native.drawPicture(rendered.picture)
                        } finally { native.restore() }
                    }
                }
            } else if (drawing == null) CircularProgressIndicator(Modifier.align(Alignment.Center))
            else Column(Modifier.align(Alignment.Center).padding(24.dp)) {
                Text(drawing?.exceptionOrNull()?.message ?: "페이지를 그리지 못했습니다.")
                TextButton(onClick = { attempt++ }) { Text("다시 그리기") }
            }
        }
        if (content?.warnings?.isNotEmpty() == true) {
            Text(content.warnings.joinToString("\n"),
                Modifier.align(Alignment.BottomCenter).background(Color.White).padding(8.dp),
                color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
    }
}
