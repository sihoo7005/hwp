package com.sihoo.hwp

import android.graphics.Picture
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.zIndex
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
    modifier: Modifier = Modifier, editable: Boolean = false,
    onSelectTextRun: (PageTextRun) -> Unit = {}, onEditTextRun: (PageTextRun, String) -> Unit = { _, _ -> }) {
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
                    var active by remember(document.id, index, document.revision) { mutableStateOf<PageTextRun?>(null) }
                    var value by remember(active) { mutableStateOf(active?.text.orEmpty()) }
                    val focusRequester = remember { FocusRequester() }
                    LaunchedEffect(active) { if (active != null) focusRequester.requestFocus() }
                    val density = LocalDensity.current
                    BoxWithConstraints(Modifier.fillMaxWidth().aspectRatio(drawing.width / drawing.height)
                        .semantics { contentDescription = "${index + 1}쪽 원본 서식" }) {
                        val scale = maxWidth.value / drawing.width
                        Canvas(Modifier.fillMaxSize()) {
                            drawIntoCanvas { canvas ->
                                val native = canvas.nativeCanvas
                                native.save()
                                try {
                                    native.scale(size.width / drawing.width, size.width / drawing.width)
                                    native.drawPicture(drawing.picture)
                                } finally { native.restore() }
                            }
                        }
                        if (editable) loaded.content.textRuns.forEach { run ->
                            val x = (run.x * scale).dp
                            val y = (run.y * scale).dp
                            val width = maxOf((run.width * scale).dp, 8.dp)
                            val height = maxOf((run.height * scale).dp, 12.dp)
                            Box(Modifier.offset(x, y).size(width, height).clickable {
                                active = run
                                value = run.text
                                onSelectTextRun(run)
                            })
                        }
                        active?.let { run ->
                            val x = (run.x * scale).dp.coerceAtMost((maxWidth - 120.dp).coerceAtLeast(0.dp))
                            val y = (run.y * scale).dp.let { top ->
                                if (top + 100.dp > maxHeight) (top - 100.dp).coerceAtLeast(0.dp) else top
                            }
                            val runWidth = maxOf((run.width * scale).dp, 80.dp)
                            val fieldWidth = minOf(maxWidth - x, maxOf(runWidth, 120.dp)).coerceAtLeast(80.dp)
                            val fontSize = with(density) { ((run.height * scale).dp.toSp().value * .78f).sp }
                            fun finish() {
                                active?.let { onEditTextRun(it, value) }
                                active = null
                            }
                            Column(Modifier.offset(x, y).width(fieldWidth).zIndex(2f)
                                .shadow(4.dp).background(Color.White).border(1.dp, MaterialTheme.colorScheme.primary)
                                .padding(4.dp)) {
                                BasicTextField(value, { value = it }, Modifier.fillMaxWidth().focusRequester(focusRequester), singleLine = true,
                                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = fontSize, color = Color.Black),
                                    keyboardOptions = KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                                    keyboardActions = KeyboardActions(onDone = { finish() }))
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                    TextButton(onClick = { active = null }, contentPadding = PaddingValues(horizontal = 6.dp)) {
                                        Text("취소", style = MaterialTheme.typography.labelSmall)
                                    }
                                    TextButton(onClick = { finish() }, contentPadding = PaddingValues(horizontal = 6.dp)) {
                                        Text("적용", style = MaterialTheme.typography.labelSmall)
                                    }
                                }
                            }
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
