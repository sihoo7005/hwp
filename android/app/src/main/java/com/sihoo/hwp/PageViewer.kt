package com.sihoo.hwp

import android.graphics.Picture
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import org.json.JSONObject
import org.json.JSONArray
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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

// The workspace owns the IME buffer, so recycling a page cannot discard uncommitted text.
internal data class TextRunDraft(val page: Int, val run: PageTextRun, val value: TextFieldValue, val documentId: Long) {
    val changed get() = value.text != run.text
}

internal val TextRunDraftSaver = Saver<TextRunDraft?, String>(
    save = { edit -> edit?.let {
        val run = it.run
        JSONObject().put("documentId", it.documentId).put("page", it.page).put("section", run.section).put("paragraph", run.paragraph)
            .put("start", run.start).put("before", run.text).put("text", it.value.text)
            .put("selectionStart", it.value.selection.start).put("selectionEnd", it.value.selection.end)
            .put("x", run.x.toDouble()).put("y", run.y.toDouble())
            .put("width", run.width.toDouble()).put("height", run.height.toDouble())
            .put("path", JSONArray().apply { run.cellPath.forEach { cell ->
                put(JSONArray().put(cell.first).put(cell.second).put(cell.third))
            } }).toString()
    } ?: "" },
    restore = { raw -> if (raw.isEmpty()) null else runCatching {
        val json = JSONObject(raw)
        val path = json.getJSONArray("path")
        val run = PageTextRun(json.getInt("section"), json.getInt("paragraph"), json.getInt("start"),
            json.getString("before"), json.getDouble("x").toFloat(), json.getDouble("y").toFloat(),
            json.getDouble("width").toFloat(), json.getDouble("height").toFloat(),
            List(path.length()) { i -> path.getJSONArray(i).let { Triple(it.getInt(0), it.getInt(1), it.getInt(2)) } })
        val text = json.getString("text")
        TextRunDraft(json.getInt("page"), run, TextFieldValue(text, TextRange(
            json.getInt("selectionStart").coerceIn(0, text.length), json.getInt("selectionEnd").coerceIn(0, text.length))), json.getLong("documentId"))
    }.getOrNull() }
)

@Composable
internal fun PageViewer(document: ReadDocument, index: Int, textMode: Boolean,
    modifier: Modifier = Modifier, editable: Boolean = false,
    draft: TextRunDraft? = null, onDraftChanged: (TextRunDraft) -> Unit = {},
    onSelectTextRun: (PageTextRun) -> Unit = {}, onApplyDraft: () -> Unit = {}) {
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
    val currentDraft by rememberUpdatedState(draft)
    val updateDraft by rememberUpdatedState(onDraftChanged)
    val selectRun by rememberUpdatedState(onSelectTextRun)
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
                    val focusRequester = remember { FocusRequester() }
                    val active = draft?.takeIf { it.page == index }
                    LaunchedEffect(active?.run) { if (active != null && editable) focusRequester.requestFocus() }
                    val density = LocalDensity.current
                    BoxWithConstraints(Modifier.fillMaxWidth().aspectRatio(drawing.width / drawing.height)
                        .semantics { contentDescription = "${index + 1}쪽 원본 서식" }) {
                        val scale = maxWidth.value / drawing.width
                        Canvas(Modifier.fillMaxSize().pointerInput(document.id, index, document.revision, editable, scale) {
                            if (editable) detectTapGestures { point ->
                                // Finish through the workspace before changing editing targets.
                                if (currentDraft != null) return@detectTapGestures
                                val docX = with(density) { point.x.toDp().value } / scale
                                val docY = with(density) { point.y.toDp().value } / scale
                                val hit = runCatching { NativeReader.hitTest(document.id, index, docX, docY) }.getOrNull()
                                    ?: (if (index == 0 && loaded.content.textRuns.isEmpty()) document.editing.paragraphs
                                        .firstOrNull { it.editable && it.text.isEmpty() }
                                        ?.let { PageHit(it.section, it.paragraph, 0, emptyList()) } else null)
                                    ?: return@detectTapGestures
                                val target = loaded.content.textRuns.firstOrNull { candidate ->
                                    candidate.section == hit.section && candidate.paragraph == hit.paragraph &&
                                        candidate.cellPath == hit.cellPath && hit.offset in candidate.start..
                                        (candidate.start + candidate.text.codePointCount(0, candidate.text.length))
                                } ?: (if (hit.cellPath.isNotEmpty() && hit.offset == 0 || document.editing.paragraphs.any {
                                    it.section == hit.section && it.paragraph == hit.paragraph && it.text.isEmpty()
                                }) PageTextRun(hit.section, hit.paragraph, 0, "", docX.coerceAtLeast(24f),
                                    docY.coerceAtLeast(24f), 140f, 18f, hit.cellPath) else null)
                                    ?: return@detectTapGestures
                                val caret = (hit.offset - target.start).coerceIn(0, target.text.codePointCount(0, target.text.length))
                                updateDraft(TextRunDraft(index, target,
                                    TextFieldValue(target.text, TextRange(target.text.offsetByCodePoints(0, caret))), document.id))
                                selectRun(target)
                            }
                        }) {
                            drawIntoCanvas { canvas ->
                                val native = canvas.nativeCanvas
                                native.save()
                                try {
                                    native.scale(size.width / drawing.width, size.width / drawing.width)
                                    native.drawPicture(drawing.picture)
                                } finally { native.restore() }
                            }
                        }
                        active?.let { edit ->
                            val run = edit.run
                            val x = (run.x * scale).dp.coerceIn(0.dp, (maxWidth - 48.dp).coerceAtLeast(0.dp))
                            val y = (run.y * scale).dp
                            val fieldWidth = minOf(maxWidth - x, maxOf((run.width * scale).dp, 120.dp))
                            val fontSize = with(density) { ((run.height * scale).dp.toSp().value * .78f).coerceAtLeast(12f).sp }
                            BasicTextField(edit.value, { onDraftChanged(edit.copy(value = it)) },
                                Modifier.offset(x, y).width(fieldWidth).heightIn(min = 32.dp)
                                    .zIndex(2f).background(Color(0xFFEAF2FF)).focusRequester(focusRequester)
                                    .testTag("page-text-editor").padding(2.dp),
                                enabled = editable, singleLine = false,
                                textStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = fontSize, color = Color.Black),
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                                keyboardActions = KeyboardActions(onDone = { onApplyDraft() }))
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
