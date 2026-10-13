package com.sihoo.hwp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.layout.layout
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.DpSize
import kotlin.math.roundToInt
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF2457C5))) { ReaderScreen() }
        }
    }
}
@Composable
private fun ReaderScreen(reader: ReaderViewModel = viewModel()) {
    val state by reader.state.collectAsStateWithLifecycle()
    var pendingPictureTarget by remember { mutableStateOf<PageTextRun?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(reader::open) }
    val fonts = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(reader::addFont) }
    val pictures = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        pendingPictureTarget?.let { target -> uri?.let { reader.insertPicture(target, it) } }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { it?.let(reader::save) }
    EditorWorkspace(state, { picker.launch(arrayOf("*/*")) },
        { fonts.launch(arrayOf("*/*")) }, reader::close,
        onSave = { save.launch(it) }, onHistory = reader::history,
        onMutate = { paragraph, operation, properties -> reader.mutate(paragraph, operation, properties) },
        onEditTextRun = reader::editTextRun,
        onInsertPicture = { paragraph -> pendingPictureTarget = paragraph; pictures.launch(arrayOf("image/*")) })
}

@Composable
internal fun EditorWorkspace(state: ReaderState, onOpen: () -> Unit, onAddFont: () -> Unit,
    onClose: () -> Unit = {}, onSave: (String) -> Unit = {},
    onHistory: (Boolean) -> Unit = {},
    onMutate: (EditorParagraph, String, JSONObject) -> Unit = { _, _, _ -> },
    onEditTextRun: (PageTextRun, String) -> Unit = { _, _ -> },
    onInsertPicture: (PageTextRun) -> Unit = {}) {
    val ready = state as? ReaderState.Ready
    val document = ready?.document
    val busy = state is ReaderState.Loading
    val scope = rememberCoroutineScope()
    val listState = key(document?.id) { rememberLazyListState() }
    val horizontal = key(document?.id) { rememberScrollState() }
    var tab by rememberSaveable { mutableStateOf("홈") }
    var fileMenu by remember { mutableStateOf(false) }
    var help by remember { mutableStateOf(false) }
    var discardAction by remember { mutableStateOf<(() -> Unit)?>(null) }
    var zoom by remember(document?.id) { mutableFloatStateOf(1f) }
    var textMode by rememberSaveable(document?.id) { mutableStateOf(false) }
    var showJump by remember(document?.id) { mutableStateOf(false) }
    var selectedParagraph by remember(document?.id) { mutableStateOf<EditorParagraph?>(null) }
    var selectedTextRun by remember(document?.id) { mutableStateOf<PageTextRun?>(null) }
    var insertDialog by remember { mutableStateOf("") }
    var tableRows by remember { mutableStateOf("2") }
    var tableColumns by remember { mutableStateOf("2") }
    var equationScript by remember { mutableStateOf("x = y") }
    var jump by remember(document?.id) { mutableStateOf("") }
    val currentPage by remember(listState) { derivedStateOf { listState.firstVisibleItemIndex + 1 } }
    val zoomGesture = rememberTransformableState { change, offset, _ ->
        if (!textMode) {
            zoom = (zoom * change).coerceIn(.5f, 5f)
            scope.launch { horizontal.scrollTo((horizontal.value - offset.x).toInt().coerceAtLeast(0)) }
        }
    }
    fun jumpToPage() { jump = currentPage.toString(); showJump = true }
    fun request(action: () -> Unit) {
        if (document?.editing?.dirty == true) discardAction = action else action()
    }

    Column(Modifier.fillMaxSize().background(Color(0xFFF5F7FA)).safeDrawingPadding()) {
        val viewConfiguration = LocalViewConfiguration.current
        val compactConfiguration = remember(viewConfiguration) {
            object : ViewConfiguration by viewConfiguration {
                override val minimumTouchTargetSize = DpSize(
                    viewConfiguration.minimumTouchTargetSize.width / .8f,
                    viewConfiguration.minimumTouchTargetSize.height / .8f)
            }
        }
        // Keep physical touch targets at their original size while shrinking the chrome.
        CompositionLocalProvider(LocalViewConfiguration provides compactConfiguration) {
            Column(Modifier.fillMaxWidth().compactTopUi()) {
                // A compact title strip and ribbon leave most of a phone screen for the document.
                Row(Modifier.fillMaxWidth().height(44.dp).background(Color(0xFF173C75)).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("HWP", color = Color.White, fontWeight = FontWeight.Bold)
                    Text(ready?.name ?: "한글 문서", Modifier.weight(1f).padding(horizontal = 12.dp),
                        color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { request(onOpen) }, enabled = !busy) { Text("열기", color = Color.White) }
                }
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        TextButton(onClick = { fileMenu = true }) { Text("파일") }
                        DropdownMenu(fileMenu, { fileMenu = false }) {
                            DropdownMenuItem(text = { Text("문서 열기") }, enabled = !busy,
                                onClick = { fileMenu = false; request(onOpen) })
                            DropdownMenuItem(text = { Text("글꼴 추가") }, enabled = !busy && document?.editing?.dirty != true,
                                onClick = { fileMenu = false; onAddFont() })
                            HorizontalDivider()
                            DropdownMenuItem(text = { Text("다른 이름으로 저장") },
                                enabled = document?.editing?.canEdit == true && !busy,
                                onClick = { fileMenu = false; ready?.let { onSave(saveName(it)) } })
                            DropdownMenuItem(text = { Text("문서 닫기") }, enabled = document != null && !busy,
                                onClick = { fileMenu = false; request(onClose) })
                            Text(ready?.document?.editing?.reason?.takeIf(String::isNotBlank) ?: "변경 내용은 새 파일로 저장합니다.",
                                Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    for (name in listOf("홈", "삽입", "보기")) {
                        TextButton(onClick = { tab = name }, modifier = Modifier.background(
                            if (tab == name) Color(0xFFE3EBF8) else Color.Transparent)) {
                            Text(name, fontWeight = if (tab == name) FontWeight.Bold else FontWeight.Normal)
                        }
                    }
                    TextButton(onClick = { help = true }) { Text("도움말") }
                }
                HorizontalDivider()
                Row(Modifier.fillMaxWidth().height(48.dp).background(Color.White)
                    .horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    when (tab) {
                        "홈" -> {
                            TextButton(onClick = { textMode = !textMode }, enabled = document != null) {
                                Text(if (textMode) "쪽 편집" else "본문 복사")
                            }
                            for ((label, props) in listOf(
                                "굵게" to JSONObject().put("bold", true),
                                "기울임" to JSONObject().put("italic", true),
                                "밑줄" to JSONObject().put("underline", true))) {
                                TextButton(onClick = { selectedParagraph?.let { paragraph ->
                                    val run = selectedTextRun
                                    val applied = JSONObject(props.toString())
                                    if (run != null) {
                                        applied.put("start", run.start).put("end", run.start + run.text.codePointCount(0, run.text.length))
                                        applied.put("cellPath", org.json.JSONArray().apply { run.cellPath.forEach {
                                            put(org.json.JSONArray().put(it.first).put(it.second).put(it.third))
                                        } })
                                    }
                                    onMutate(paragraph, "characterFormat", applied)
                                } },
                                    enabled = selectedParagraph != null && !busy && document?.editing?.canEdit == true) { Text(label) }
                            }
                            for ((label, alignment) in listOf("왼쪽" to "left", "가운데" to "center", "오른쪽" to "right")) {
                                TextButton(onClick = { selectedParagraph?.let {
                                    onMutate(it, "paragraphFormat", JSONObject().put("alignment", alignment))
                                    } }, enabled = selectedParagraph != null && selectedTextRun?.cellPath?.isEmpty() == true &&
                                    !busy && document?.editing?.canEdit == true) { Text(label) }
                            }
                            TextButton(onClick = onAddFont, enabled = !busy && document?.editing?.dirty != true) { Text("글꼴 추가") }
                            VerticalDivider(Modifier.height(24.dp))
                            TextButton(onClick = { onHistory(false) }, enabled = document?.editing?.canUndo == true && !busy) { Text("↶ 실행 취소") }
                            TextButton(onClick = { onHistory(true) }, enabled = document?.editing?.canRedo == true && !busy) { Text("↷ 다시 실행") }
                            TextButton(onClick = { ready?.let { onSave(saveName(it)) } },
                                enabled = document?.editing?.let { it.canEdit && it.dirty } == true && !busy) { Text("저장") }
                        }
                        "삽입" -> {
                            TextButton(onClick = { insertDialog = "table" },
                                enabled = selectedParagraph != null && selectedTextRun?.cellPath?.isEmpty() == true &&
                                    !busy && document?.editing?.canEdit == true) { Text("표") }
                            TextButton(onClick = { insertDialog = "equation" },
                                enabled = selectedParagraph != null && selectedTextRun?.cellPath?.isEmpty() == true &&
                                    !busy && document?.editing?.canEdit == true) { Text("수식") }
                            TextButton(onClick = { selectedParagraph?.let {
                                val run = selectedTextRun ?: return@let
                                onMutate(it, "insertShape", JSONObject().put("offset",
                                    run.start + run.text.codePointCount(0, run.text.length)))
                            } }, enabled = selectedParagraph != null && selectedTextRun?.cellPath?.isEmpty() == true &&
                                !busy && document?.editing?.canEdit == true) { Text("사각형") }
                            TextButton(onClick = { selectedTextRun?.takeIf { it.cellPath.isEmpty() }?.let(onInsertPicture) },
                                enabled = selectedParagraph != null && selectedTextRun?.cellPath?.isEmpty() == true &&
                                    !busy && document?.editing?.canEdit == true) { Text("그림") }
                            Text("글자 위치를 눌러 입력 · 키보드 완료로 반영", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        "보기" -> {
                            TextButton(onClick = { zoom = 1f; scope.launch { horizontal.scrollTo(0) } },
                                enabled = document != null && !textMode) { Text("폭 맞춤") }
                            TextButton(onClick = { textMode = !textMode }, enabled = document != null) {
                                Text(if (textMode) "쪽 보기" else "본문 복사")
                            }
                            TextButton(onClick = { jumpToPage() }, enabled = document != null) { Text("쪽 이동") }
                            TextButton(onClick = onAddFont, enabled = !busy && document?.editing?.dirty != true) { Text("글꼴 추가") }
                        }
                    }
                }
                HorizontalDivider()
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (state) {
                ReaderState.Empty -> Column(Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("문서를 열어 보세요", style = MaterialTheme.typography.titleLarge)
                    Text("HWP 3.x · HWP 5.x · HWPX\n원본 서식을 유지해 페이지를 이어서 표시합니다.",
                        Modifier.padding(vertical = 16.dp), style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = { request(onOpen) }) { Text("문서 열기") }
                }
                is ReaderState.Loading -> Column(Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                    Text(state.message, Modifier.padding(top = 16.dp))
                }
                is ReaderState.Error -> Column(Modifier.align(Alignment.Center).padding(24.dp)) {
                    Text(state.message, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = onOpen) { Text("다른 문서 열기") }
                }
                is ReaderState.Ready -> BoxWithConstraints(Modifier.fillMaxSize()) {
                    val pageWidth = (maxWidth - 24.dp) * zoom
                    val contentWidth = maxOf(maxWidth, pageWidth + 24.dp)
                    Box(Modifier.fillMaxSize().background(Color(0xFFE5E8EF))
                        .transformable(zoomGesture, canPan = { false }, enabled = !textMode)
                        .horizontalScroll(horizontal)) {
                        LazyColumn(Modifier.width(contentWidth).fillMaxHeight().testTag("document-pages"),
                            state = listState, contentPadding = PaddingValues(vertical = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally) {
                            items(state.document.totalPages, key = { it }) { index ->
                                Column(Modifier.width(pageWidth)) {
                                    Text("${index + 1}쪽", Modifier.padding(bottom = 6.dp),
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    PageViewer(state.document, index, textMode,
                                        Modifier.fillMaxWidth().border(1.dp, Color(0xFFCBD2DC)),
                                        editable = state.document.editing.canEdit && !textMode,
                                        onSelectTextRun = { run ->
                                            selectedTextRun = run
                                            selectedParagraph = EditorParagraph(run.section, run.paragraph, run.text, true)
                                        }, onEditTextRun = { run, text ->
                                            onEditTextRun(run, text)
                                            selectedTextRun = null
                                            selectedParagraph = null
                                        })
                                }
                            }
                        }
                    }
                }
            }
        }
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().height(44.dp).background(Color.White).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { jumpToPage() }, enabled = document != null,
                modifier = Modifier.testTag("page-status"), contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text(if (document == null) "문서 없음" else "$currentPage / ${document.totalPages}쪽",
                    style = MaterialTheme.typography.labelMedium)
            }
            Text(ready?.message ?: when {
                document == null -> "문서 없음"
                document.editing.dirty -> "저장하지 않은 변경"
                document.editing.canEdit -> "편집 가능"
                else -> "읽기 전용"
            }, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { zoom = (zoom / 1.25f).coerceAtLeast(.5f) },
                enabled = document != null && !textMode, modifier = Modifier.width(36.dp).semantics {
                    contentDescription = "축소"
                }, contentPadding = PaddingValues(0.dp)) { Text("−") }
            TextButton(onClick = { zoom = 1f; scope.launch { horizontal.scrollTo(0) } },
                enabled = document != null && !textMode, contentPadding = PaddingValues(horizontal = 4.dp)) {
                Text("${(zoom * 100).toInt()}%", style = MaterialTheme.typography.labelMedium)
            }
            TextButton(onClick = { zoom = (zoom * 1.25f).coerceAtMost(5f) },
                enabled = document != null && !textMode, modifier = Modifier.width(36.dp).semantics {
                    contentDescription = "확대"
                }, contentPadding = PaddingValues(0.dp)) { Text("+") }
        }
    }
    if (showJump && document != null) {
        val target = jump.toIntOrNull()?.takeIf { it in 1..document.totalPages }
        AlertDialog(onDismissRequest = { showJump = false }, title = { Text("쪽 이동") },
            text = { OutlinedTextField(jump, { jump = it.filter(Char::isDigit).take(6) },
                singleLine = true, label = { Text("1 ~ ${document.totalPages}") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)) },
            confirmButton = { TextButton(enabled = target != null, onClick = {
                target?.let { scope.launch { listState.scrollToItem(it - 1) } }
                showJump = false
            }) { Text("이동") } },
            dismissButton = { TextButton(onClick = { showJump = false }) { Text("취소") } })
    }
    if (insertDialog.isNotEmpty()) {
        val isTable = insertDialog == "table"
        val valid = if (isTable) tableRows.toIntOrNull()?.let { it in 1..50 } == true &&
            tableColumns.toIntOrNull()?.let { it in 1..20 } == true
            else equationScript.isNotBlank()
        AlertDialog(onDismissRequest = { insertDialog = "" },
            title = { Text(if (isTable) "표 삽입" else "수식 삽입") },
            text = {
                if (isTable) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(tableRows, { tableRows = it.filter(Char::isDigit).take(2) },
                        label = { Text("행 (1~50)") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    OutlinedTextField(tableColumns, { tableColumns = it.filter(Char::isDigit).take(2) },
                        label = { Text("열 (1~20)") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                } else OutlinedTextField(equationScript, { equationScript = it },
                    label = { Text("수식 표현") }, minLines = 2)
            },
            confirmButton = { TextButton(enabled = valid && selectedParagraph != null && !busy, onClick = {
                selectedParagraph?.let { paragraph ->
                    if (isTable) onMutate(paragraph, "insertTable", JSONObject()
                        .put("rows", tableRows.toInt()).put("columns", tableColumns.toInt())
                        .put("offset", selectedTextRun?.let { it.start + it.text.codePointCount(0, it.text.length) } ?: 0))
                    else onMutate(paragraph, "insertEquation", JSONObject().put("script", equationScript)
                        .put("offset", selectedTextRun?.let { it.start + it.text.codePointCount(0, it.text.length) } ?: 0))
                }
                insertDialog = ""
            }) { Text("삽입") } },
            dismissButton = { TextButton(onClick = { insertDialog = "" }) { Text("취소") } })
    }
    if (help) {
        AlertDialog(onDismissRequest = { help = false }, title = { Text("문서 사용 안내") },
            text = { Text("위아래로 스크롤해 다음 쪽을 읽습니다. 두 손가락이나 아래 배율 버튼으로 확대하고, 확대된 문서는 좌우로 이동할 수 있습니다.\n\n파일 메뉴에서 문서와 글꼴을 열 수 있습니다. 원본 글꼴이 없으면 대체 글꼴을 사용합니다.\n\n쪽에서 글자를 누르면 해당 위치에서 바로 수정할 수 있습니다. 홈 탭에서 굵게·기울임·밑줄과 문단 정렬을 적용하고, 삽입 탭에서 표·수식·사각형 도형·그림을 추가할 수 있습니다. 변경은 실행 취소·다시 실행과 새 HWP/HWPX 저장을 지원합니다. 기존 그림·도형·차트의 세부 수정은 아직 연결 중입니다." +
                if (document?.warnings?.isNotEmpty() == true) "\n\n문서 경고:\n" + document.warnings.take(10).joinToString("\n") else "") },
            confirmButton = { TextButton(onClick = { help = false }) { Text("확인") } })
    }
    discardAction?.let { action ->
        AlertDialog(onDismissRequest = { discardAction = null }, title = { Text("저장하지 않은 변경") },
            text = { Text("편집한 내용을 버리고 계속할까요? 필요하면 먼저 파일 메뉴에서 편집본을 저장하세요.") },
            confirmButton = { TextButton(onClick = {
                discardAction = null
                onClose()
                action()
            }) { Text("변경 버리기") } },
            dismissButton = { TextButton(onClick = { discardAction = null }) { Text("취소") } })
    }
}


private fun saveName(ready: ReaderState.Ready): String {
    val fileName = ready.name.substringAfterLast('/')
    val base = fileName.substringBeforeLast('.', fileName).ifBlank { "한글 문서" }
    val extension = if (ready.document.format == "hwpx") "hwpx" else "hwp"
    return "$base-편집본.$extension"
}

private fun Modifier.compactTopUi() = layout { measurable, constraints ->
    val scale = .8f
    fun expand(value: Int) = if (value == Constraints.Infinity) value else (value / scale).roundToInt()
    val child = measurable.measure(constraints.copy(
        minWidth = expand(constraints.minWidth), maxWidth = expand(constraints.maxWidth),
        minHeight = expand(constraints.minHeight), maxHeight = expand(constraints.maxHeight)))
    layout((child.width * scale).roundToInt(), (child.height * scale).roundToInt()) {
        child.placeWithLayer(0, 0) {
            scaleX = scale
            scaleY = scale
            transformOrigin = TransformOrigin(0f, 0f)
        }
    }
}
