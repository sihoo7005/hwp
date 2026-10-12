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
    EditorWorkspace(state, { picker.launch(arrayOf("*/*")) },
        { fonts.launch(arrayOf("*/*")) }, reader::close)
}

@Composable
internal fun EditorWorkspace(state: ReaderState, onOpen: () -> Unit, onAddFont: () -> Unit,
    onClose: () -> Unit = {}) {
    val ready = state as? ReaderState.Ready
    val document = ready?.document
    val busy = state is ReaderState.Loading
    val scope = rememberCoroutineScope()
    val listState = key(document?.id) { rememberLazyListState() }
    val horizontal = key(document?.id) { rememberScrollState() }
    var tab by rememberSaveable { mutableStateOf("홈") }
    var fileMenu by remember { mutableStateOf(false) }
    var help by remember { mutableStateOf(false) }
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

    Column(Modifier.fillMaxSize().background(Color(0xFFF5F7FA)).safeDrawingPadding()) {
        // A compact title strip and ribbon leave most of a phone screen for the document.
        Row(Modifier.fillMaxWidth().height(44.dp).background(Color(0xFF173C75)).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text("HWP", color = Color.White, fontWeight = FontWeight.Bold)
            Text(ready?.name ?: "한글 문서", Modifier.weight(1f).padding(horizontal = 12.dp),
                color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onOpen, enabled = !busy) { Text("열기", color = Color.White) }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            Box {
                TextButton(onClick = { fileMenu = true }) { Text("파일") }
                DropdownMenu(fileMenu, { fileMenu = false }) {
                    DropdownMenuItem(text = { Text("문서 열기") }, enabled = !busy,
                        onClick = { fileMenu = false; onOpen() })
                    DropdownMenuItem(text = { Text("글꼴 추가") }, enabled = !busy,
                        onClick = { fileMenu = false; onAddFont() })
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text("저장") }, enabled = false, onClick = {})
                    DropdownMenuItem(text = { Text("다른 이름으로 저장") }, enabled = false, onClick = {})
                    DropdownMenuItem(text = { Text("문서 닫기") }, enabled = document != null && !busy,
                        onClick = { fileMenu = false; onClose() })
                    Text("현재 읽기 전용입니다.", Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
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
                        Text(if (textMode) "원본 보기" else "텍스트 복사")
                    }
                    TextButton(onClick = onAddFont, enabled = !busy) { Text("글꼴 추가") }
                    VerticalDivider(Modifier.height(24.dp))
                    TextButton(onClick = {}, enabled = false) { Text("↶ 실행 취소") }
                    TextButton(onClick = {}, enabled = false) { Text("↷ 다시 실행") }
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
                        Text(if (textMode) "원본 보기" else "텍스트 보기")
                    }
                    TextButton(onClick = { jumpToPage() }, enabled = document != null) { Text("쪽 이동") }
                    TextButton(onClick = onAddFont, enabled = !busy) { Text("글꼴 추가") }
                }
            }
        }
        HorizontalDivider()
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (state) {
                ReaderState.Empty -> Column(Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("문서를 열어 보세요", style = MaterialTheme.typography.titleLarge)
                    Text("HWP 3.x · HWP 5.x · HWPX\n원본 서식을 유지해 페이지를 이어서 표시합니다.",
                        Modifier.padding(vertical = 16.dp), style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = onOpen) { Text("문서 열기") }
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
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().height(44.dp).background(Color.White).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { jumpToPage() }, enabled = document != null,
                modifier = Modifier.testTag("page-status"), contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text(if (document == null) "문서 없음" else "$currentPage / ${document.totalPages}쪽",
                    style = MaterialTheme.typography.labelMedium)
            }
            Text("읽기 전용", Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
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
            text = { Text("위아래로 스크롤해 다음 쪽을 읽습니다. 두 손가락이나 아래 배율 버튼으로 확대하고, 확대된 문서는 좌우로 이동할 수 있습니다.\n\n파일 메뉴에서 문서와 글꼴을 열 수 있습니다. 원본 글꼴이 없으면 대체 글꼴을 사용합니다.\n\n현재 읽기 전용이며 삽입·편집·저장은 아직 지원하지 않습니다." +
                if (document?.warnings?.isNotEmpty() == true) "\n\n문서 경고:\n" + document.warnings.take(10).joinToString("\n") else "") },
            confirmButton = { TextButton(onClick = { help = false }) { Text("확인") } })
    }
}
