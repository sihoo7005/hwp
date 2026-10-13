package com.sihoo.hwp

import android.graphics.Picture
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.caverock.androidsvg.SVG
import java.io.File
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
    return CanvasPage(svg.renderToPicture())
}
private data class LoadedPage(val content: RenderedPage, val drawing: CanvasPage)

@Composable
fun PageViewer(document: ReadDocument, index: Int, textMode: Boolean,
    modifier: Modifier = Modifier) {
    var attempt by remember(document.id, index, document.revision) { mutableIntStateOf(0) }
    val page by produceState<Result<LoadedPage>?>(null, document.id, index, attempt, document.revision) {
        value = null
        value = try {
            Result.success(withContext(Dispatchers.IO) {
                val content = NativeReader.page(document.id, index)
                LoadedPage(content, loadCanvasPage(content.file))
            })
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { Result.failure(error) }
    }
    BoxWithConstraints(modifier.clipToBounds().background(Color.White)) {
        val loaded = page?.getOrNull()
        if (loaded == null) {
            Box(Modifier.fillMaxWidth().height(maxWidth * 1.4142f), contentAlignment = Alignment.Center) {
                Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (page == null) CircularProgressIndicator()
                    else {
                        Text(page?.exceptionOrNull()?.message ?: "이 쪽을 표시하지 못했습니다.")
                        TextButton(onClick = { attempt++ }) { Text("다시 그리기") }
                    }
                }
            }
        } else {
            Column(Modifier.fillMaxWidth()) {
                if (textMode) {
                    SelectionContainer {
                        Text(loaded.content.text.ifBlank { "추출할 텍스트가 없습니다." }, Modifier.padding(20.dp))
                    }
                } else {
                    val drawing = loaded.drawing
                    // Natural page height lets the parent list scroll through the whole sheet.
                    // Parent width controls zoom; the same vector Picture is replayed.
                    Canvas(Modifier.fillMaxWidth().aspectRatio(drawing.width / drawing.height).semantics {
                        contentDescription = "${index + 1}쪽 원본 서식"
                    }) {
                        drawIntoCanvas { canvas ->
                            val native = canvas.nativeCanvas
                            native.save()
                            try {
                                val scale = size.width / drawing.width
                                native.scale(scale, scale)
                                native.drawPicture(drawing.picture)
                            } finally { native.restore() }
                        }
                    }
                }
                if (loaded.content.warnings.isNotEmpty()) {
                    Text(loaded.content.warnings.joinToString("\n"), Modifier.padding(8.dp),
                        color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
