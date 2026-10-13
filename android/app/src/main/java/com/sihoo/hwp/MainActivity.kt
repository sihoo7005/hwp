package com.sihoo.hwp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(reader::open) }
    val fonts = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(reader::addFont) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { it?.let(reader::save) }
    EditorWorkspace(state, { picker.launch(arrayOf("*/*")) },
        { fonts.launch(arrayOf("*/*")) }, reader::close,
        onSave = { save.launch(it) }, onEdit = reader::edit, onHistory = reader::history)
}

@Composable
internal fun EditorWorkspace(state: ReaderState, onOpen: () -> Unit, onAddFont: () -> Unit,
    onClose: () -> Unit = {}, onSave: (String) -> Unit = {},
    onEdit: (EditorParagraph, String) -> Unit = { _, _ -> }, onHistory: (Boolean) -> Unit = {}) {
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
                                Text(if (textMode) "원본 보기" else if (document?.editing?.canEdit == true) "텍스트 편집" else "텍스트 복사")
                            }
                            TextButton(onClick = onAddFont, enabled = !busy && document?.editing?.dirty != true) { Text("글꼴 추가") }
                            VerticalDivider(Modifier.height(24.dp))
                            TextButton(onClick = { onHistory(false) }, enabled = document?.editing?.canUndo == true && !busy) { Text("↶ 실행 취소") }
                            TextButton(onClick = { onHistory(true) }, enabled = document?.editing?.canRedo == true && !busy) { Text("↷ 다시 실행") }
                            TextButton(onClick = { ready?.let { onSave(saveName(it)) } },
                                enabled = document?.editing?.let { it.canEdit && it.dirty } == true && !busy) { Text("저장") }
                        }
                        "삽입" -> {
                            for (name in listOf("표", "그림", "도형", "수식", "차트")) {
                                TextButton(onClick = {}, enabled = false) { Text(name) }
                            }
                            Text("삽입 기능 준비 중", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        "보기" -> {
                            TextButton(onClick = { zoom = 1f; scope.launch { horizontal.scrollTo(0) } },
                                enabled = document != null && !textMode) { Text("폭 맞춤") }
                            TextButton(onClick = { textMode = !textMode }, enabled = document != null) {
                                Text(if (textMode) "원본 보기" else if (document?.editing?.canEdit == true) "텍스트 편집" else "텍스트 보기")
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
                    if (textMode && state.document.editing.canEdit) {
                        EditorTextView(state.document.editing, onEdit, Modifier.fillMaxSize())
                    } else {
                        val pageWidth = (maxWidth - 24.dp) * if (textMode) 1f else zoom
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
                                            Modifier.fillMaxWidth().border(1.dp, Color(0xFFCBD2DC)))
                                    }
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
    if (help) {
        AlertDialog(onDismissRequest = { help = false }, title = { Text("문서 사용 안내") },
            text = { Text("위아래로 스크롤해 다음 쪽을 읽습니다. 두 손가락이나 아래 배율 버튼으로 확대하고, 확대된 문서는 좌우로 이동할 수 있습니다.\n\n파일 메뉴에서 문서와 글꼴을 열 수 있습니다. 원본 글꼴이 없으면 대체 글꼴을 사용합니다.\n\n홈 탭의 텍스트 편집에서 일반 본문 문단을 수정할 수 있습니다. 파일 메뉴에서 편집본을 새 HWP/HWPX 파일로 저장합니다. 표와 개체가 있는 문단은 아직 편집할 수 없습니다." +
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


@Composable
private fun EditorTextView(state: EditorState, onEdit: (EditorParagraph, String) -> Unit, modifier: Modifier = Modifier) {
    var selected by remember { mutableStateOf<EditorParagraph?>(null) }
    var value by remember(selected) { mutableStateOf(selected?.text.orEmpty()) }
    Column(modifier.background(Color.White)) {
        Text("본문 문단 · 개체가 포함된 문단은 읽기 전용입니다.",
            Modifier.fillMaxWidth().background(Color(0xFFEAF0F8)).padding(12.dp),
            style = MaterialTheme.typography.bodySmall)
        LazyColumn(Modifier.fillMaxSize().testTag("document-text"), contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.paragraphs, key = { "${it.section}-${it.paragraph}" }) { paragraph ->
                Surface(
                    modifier = Modifier.fillMaxWidth().clickable(enabled = paragraph.editable) { selected = paragraph },
                    color = if (paragraph.editable) Color.White else Color(0xFFF3F4F6),
                    shape = MaterialTheme.shapes.small,
                    border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFD8DEE8)),
                ) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(paragraph.text.ifBlank { "(빈 문단)" }, Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium)
                        if (!paragraph.editable) Text("읽기 전용", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
    selected?.let { paragraph ->
        AlertDialog(onDismissRequest = { selected = null }, title = { Text("문단 편집") },
            text = { OutlinedTextField(value, { value = it }, modifier = Modifier.fillMaxWidth(),
                minLines = 3, maxLines = 10, label = { Text("본문 텍스트") }) },
            confirmButton = { TextButton(enabled = value != paragraph.text, onClick = {
                onEdit(paragraph, value)
                selected = null
            }) { Text("적용") } },
            dismissButton = { TextButton(onClick = { selected = null }) { Text("취소") } })
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
