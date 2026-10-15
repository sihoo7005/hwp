package com.sihoo.hwp

import android.graphics.Picture
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
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
    onSelectTextRun: (PageTextRun) -> Unit = {},
    onUpdateTextRun: (PageTextRun, String, String) -> Unit = { _, _, _ -> },
    onFinishTextRun: () -> Unit = {}) {
    var attempt by remember(document.id, index) { mutableIntStateOf(0) }
    var page by remember(document.id, index) { mutableStateOf<Result<LoadedPage>?>(null) }
    LaunchedEffect(document.id, index, attempt, document.revision) {
        page = try {
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
                    var active by remember(document.id, index) { mutableStateOf<PageTextRun?>(null) }
                    var value by remember(document.id, index) { mutableStateOf(TextFieldValue()) }
                    val focusRequester = remember { FocusRequester() }
                    LaunchedEffect(active) { if (active != null) focusRequester.requestFocus() }
                    val density = LocalDensity.current
                    BoxWithConstraints(Modifier.fillMaxWidth().aspectRatio(drawing.width / drawing.height)
                        .semantics { contentDescription = "${index + 1}쪽 원본 서식" }) {
                        val scale = maxWidth.value / drawing.width
                        val activeRun = active
                        val fieldValue = value
                        val cursor by produceState<NativeCursorRect?>(null, document.id, index, activeRun,
                            fieldValue.selection.end, document.revision) {
                            value = activeRun?.let { run ->
                                runCatching {
                                    withContext(Dispatchers.IO) {
                                        NativeReader.cursorRect(document.id, run,
                                            fieldValue.selection.end.coerceIn(0, fieldValue.text.length).let {
                                                fieldValue.text.codePointCount(0, it)
                                            })
                                    }
                                }.getOrNull()
                            }
                        }
                        Canvas(Modifier.fillMaxSize()) {
                            drawIntoCanvas { canvas ->
                                val native = canvas.nativeCanvas
                                native.save()
                                try {
                                    native.scale(size.width / drawing.width, size.width / drawing.width)
                                    native.drawPicture(drawing.picture)
                                } finally { native.restore() }
                            }
                            cursor?.takeIf { it.page == index }?.let { caret ->
                                val x = caret.x * size.width / drawing.width
                                val y = caret.y * size.width / drawing.width
                                drawLine(Color(0xFF2457C5), Offset(x, y),
                                    Offset(x, y + caret.height * size.width / drawing.width),
                                    strokeWidth = with(density) { 1.5.dp.toPx() })
                            }
                        }
                        if (editable) loaded.content.textRuns.forEach { run ->
                            val x = (run.x * scale).dp
                            val y = (run.y * scale).dp
                            val width = maxOf((run.width * scale).dp, 8.dp)
                            val height = maxOf((run.height * scale).dp, 12.dp)
                            Box(Modifier.offset(x, y).size(width, height).pointerInput(document.id, index, run, scale) {
                                detectTapGestures { point ->
                                    active?.let { current ->
                                        onFinishTextRun()
                                        active = null
                                    }
                                    val docX = run.x + with(density) { point.x.toDp().value } / scale
                                    val docY = run.y + with(density) { point.y.toDp().value } / scale
                                    val hit = runCatching { NativeReader.hitTest(document.id, index, docX, docY) }.getOrNull()
                                    val target = hit?.let { cursor -> loaded.content.textRuns.firstOrNull { candidate ->
                                        candidate.section == cursor.section && candidate.paragraph == cursor.paragraph &&
                                            candidate.cellPath == cursor.cellPath && cursor.offset in candidate.start..(candidate.start + candidate.text.codePointCount(0, candidate.text.length))
                                    } } ?: run
                                    val caret = hit?.takeIf { it.section == target.section && it.paragraph == target.paragraph }
                                        ?.offset?.minus(target.start)?.coerceIn(0, target.text.codePointCount(0, target.text.length))
                                        ?: target.text.codePointCount(0, target.text.length)
                                    val utf16Caret = target.text.offsetByCodePoints(0, caret)
                                    active = target
                                    value = TextFieldValue(target.text, TextRange(utf16Caret))
                                    onSelectTextRun(target)
                                }
                            })
                        }
                        active?.let { run ->
                            var receivedFocus by remember(run) { mutableStateOf(false) }
                            val x = (run.x * scale).dp
                            val y = (run.y * scale).dp
                            val runWidth = maxOf((run.width * scale).dp, 48.dp)
                            val fieldWidth = minOf(maxWidth - x, maxOf(runWidth, 80.dp)).coerceAtLeast(48.dp)
                            val fontSize = with(density) { ((run.height * scale).dp.toSp().value * .78f).sp }
                            fun finish() {
                                onFinishTextRun()
                                active = null
                            }
                            Box(Modifier.offset(x, y).width(fieldWidth).height(maxOf((run.height * scale * 1.35f).dp, 24.dp))
                                .zIndex(2f)) {
                                BasicTextField(value, { next ->
                                    val before = value.text
                                    value = next
                                    onUpdateTextRun(run, before, next.text)
                                }, Modifier.fillMaxSize().focusRequester(focusRequester)
                                    .onFocusChanged {
                                        if (it.isFocused) receivedFocus = true
                                        else if (receivedFocus) finish()
                                    }, singleLine = true,
                                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = fontSize, color = Color.Transparent),
                                    cursorBrush = SolidColor(Color.Transparent),
                                    keyboardOptions = KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
                                    keyboardActions = KeyboardActions(onDone = { finish() }))
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
