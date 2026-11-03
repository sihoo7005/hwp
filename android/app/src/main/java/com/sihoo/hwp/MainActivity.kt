package com.sihoo.hwp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import kotlin.math.roundToInt
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
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
    var pendingPictureTarget by rememberSaveable(stateSaver = TextRunDraftSaver) { mutableStateOf<TextRunDraft?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(reader::open) }
    val fonts = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(reader::addFont) }
    val pictures = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        pendingPictureTarget?.let { target ->
            if ((state as? ReaderState.Ready)?.document?.id == target.documentId) {
                uri?.let { reader.insertPicture(target.run, it) }
            }
        }
        pendingPictureTarget = null
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if (uri == null) reader.cancelSave() else reader.save(uri)
    }
    EditorWorkspace(state, { picker.launch(arrayOf("*/*")) },
        { fonts.launch(arrayOf("*/*")) }, reader::close,
        onSave = { name -> reader.prepareSave(name) { save.launch(it) } }, onNew = reader::newDocument,
        onHistory = reader::history,
        onMutate = { paragraph, operation, properties -> reader.mutate(paragraph, operation, properties) },
        onEditTextRun = reader::editTextRun,
        onInsertPicture = { target ->
            pendingPictureTarget = TextRunDraft(-1, target, TextFieldValue(), (state as? ReaderState.Ready)?.document?.id ?: 0)
            pictures.launch(arrayOf("image/*"))
        })
}

@Composable
internal fun EditorWorkspace(state: ReaderState, onOpen: () -> Unit, onAddFont: () -> Unit,
    onClose: () -> Unit = {}, onSave: (String) -> Unit = {},
    onHistory: (Boolean) -> Unit = {},
    onMutate: (EditorParagraph, String, JSONObject) -> Unit = { _, _, _ -> },
    onEditTextRun: (PageTextRun, String) -> Unit = { _, _ -> },
    onInsertPicture: (PageTextRun) -> Unit = {}, onNew: () -> Unit = {}) {
    val ready = (state as? ReaderState.Ready) ?: (state as? ReaderState.Loading)?.previous
    val document = ready?.document
    val busy = state is ReaderState.Loading
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val listState = key(document?.id) { rememberLazyListState() }
    val horizontal = key(document?.id) { rememberScrollState() }
    var tab by rememberSaveable { mutableStateOf("편집") }
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
    var draft by rememberSaveable(stateSaver = TextRunDraftSaver) { mutableStateOf<TextRunDraft?>(null) }
    var submittedRevision by rememberSaveable { mutableStateOf<Int?>(null) }
    var afterCommit by remember(document?.id) { mutableStateOf<(() -> Unit)?>(null) }
    var pendingSaveName by rememberSaveable { mutableStateOf<String?>(null) }
    var saveDialog by rememberSaveable { mutableStateOf(false) }
    var saveBase by rememberSaveable { mutableStateOf("한글 문서") }
    var saveFormat by rememberSaveable { mutableStateOf("hwp") }
    var formatDialog by remember { mutableStateOf("") }
    var fontSize by remember { mutableStateOf("10") }
    var textColor by remember { mutableStateOf("#000000") }
    var lineSpacing by remember { mutableStateOf("160") }
    var deleteTableOperation by remember { mutableStateOf("") }
    val pendingChanges = draft?.changed == true
    val dirty = document?.editing?.dirty == true || pendingChanges
    val canMutate = selectedParagraph != null && !busy && document?.editing?.canEdit == true && !pendingChanges
    val canInsert = canMutate && selectedTextRun?.cellPath?.isEmpty() == true
    val canEditTable = canMutate && selectedTextRun?.cellPath?.size == 1
    val canFormatParagraph = canMutate && (selectedTextRun?.cellPath?.size ?: 0) <= 1

    fun applyDraft(then: (() -> Unit)? = null) {
        if (busy || submittedRevision != null) return
        val edit = draft
        if (edit?.changed == true) {
            submittedRevision = document?.revision
            afterCommit = then
            focusManager.clearFocus()
            keyboard?.hide()
            onEditTextRun(edit.run, edit.value.text)
        } else {
            draft = null
            focusManager.clearFocus()
            keyboard?.hide()
            then?.invoke()
        }
    }
    fun chooseSave() {
        ready?.let {
            val fileName = it.name.substringAfterLast('/')
            saveBase = fileName.substringBeforeLast('.', fileName).ifBlank { "한글 문서" }
            saveFormat = if (it.document.format == "hwpx") "hwpx" else "hwp"
            saveDialog = true
        }
    }
    LaunchedEffect(state) {
        if (state is ReaderState.Empty || state is ReaderState.Ready && draft?.let { it.documentId != state.document.id } == true) {
            draft = null
            submittedRevision = null
            pendingSaveName = null
        }
        if (state is ReaderState.Ready) draft?.let { edit ->
            selectedTextRun = edit.run
            selectedParagraph = EditorParagraph(edit.run.section, edit.run.paragraph, edit.run.text, true)
        }
        val submitted = submittedRevision
        if (state is ReaderState.Ready && submitted != null) {
            val action = afterCommit
            val saveName = pendingSaveName
            pendingSaveName = null
            afterCommit = null
            submittedRevision = null
            if (state.document.revision > submitted) {
                draft?.let { edit ->
                    if ('\n' in edit.value.text) {
                        // Enter can create new body or cell paragraphs, invalidating the original run identity.
                        selectedTextRun = null
                        selectedParagraph = null
                    } else {
                        selectedTextRun = edit.run.copy(text = edit.value.text)
                        selectedParagraph = EditorParagraph(edit.run.section, edit.run.paragraph, edit.value.text, true)
                    }
                }
                draft = null
                if (saveName != null) onSave(saveName) else action?.invoke()
            }
            // On native failure keep the complete IME buffer so the user can retry or copy it.
        }
    }
    fun characterProperties(props: JSONObject): JSONObject {
        val run = selectedTextRun ?: return props
        val selection = draft?.value?.selection?.takeUnless { it.collapsed }
        val start = selection?.min?.let { run.text.codePointCount(0, it) } ?: 0
        val end = selection?.max?.let { run.text.codePointCount(0, it) } ?: run.text.codePointCount(0, run.text.length)
        return props.put("start", run.start + start).put("end", run.start + end)
            .put("cellPath", org.json.JSONArray().apply { run.cellPath.forEach {
                put(org.json.JSONArray().put(it.first).put(it.second).put(it.third))
            } })
    }
    fun selectedOffset(): Int {
        val run = selectedTextRun ?: return 0
        return run.start + (draft?.value?.selection?.end?.let { run.text.codePointCount(0, it) }
            ?: run.text.codePointCount(0, run.text.length))
    }
    fun mutateSelected(operation: String, props: JSONObject) {
        val paragraph = selectedParagraph ?: return
        if (!canMutate) return
        val properties = if (operation == "characterFormat") characterProperties(props) else props
        properties.put("cellPath", org.json.JSONArray().apply { selectedTextRun?.cellPath?.forEach {
            put(org.json.JSONArray().put(it.first).put(it.second).put(it.third))
        } })
        draft = null
        selectedParagraph = null
        selectedTextRun = null
        focusManager.clearFocus()
        keyboard?.hide()
        onMutate(paragraph, operation, properties)
    }
    val currentPage by remember(listState) { derivedStateOf { listState.firstVisibleItemIndex + 1 } }
    val zoomGesture = rememberTransformableState { change, offset, _ ->
        if (!textMode) {
            zoom = (zoom * change).coerceIn(.5f, 5f)
            scope.launch { horizontal.scrollTo((horizontal.value - offset.x).toInt().coerceAtLeast(0)) }
        }
    }
    fun jumpToPage() { jump = currentPage.toString(); showJump = true }
    fun request(action: () -> Unit) {
        if (dirty) discardAction = action else { draft = null; action() }
    }

    BackHandler(enabled = document != null || busy) {
        if (!busy) request(onClose)
    }

    Column(Modifier.fillMaxSize().background(Color(0xFFF5F7FA)).safeDrawingPadding().imePadding()) {
        Column(Modifier.fillMaxWidth()) {
                // A compact title strip and ribbon leave most of a phone screen for the document.
                Row(Modifier.fillMaxWidth().height(48.dp).background(Color(0xFF173C75)).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("한", color = Color.White, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge)
                    Text((ready?.name ?: "모바일 한글") + if (dirty) " •" else "", Modifier.weight(1f).padding(horizontal = 12.dp),
                        color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = { request(onOpen) }, enabled = !busy) { Text("열기", color = Color.White) }
                    TextButton(onClick = { chooseSave() }, enabled = document?.editing?.canEdit == true && !busy) {
                        Text("저장", color = Color.White)
                    }
                }
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        TextButton(onClick = { fileMenu = true }) { Text("파일") }
                        DropdownMenu(fileMenu, { fileMenu = false }) {
                            DropdownMenuItem(text = { Text("새 문서") }, enabled = !busy,
                                onClick = { fileMenu = false; request(onNew) })
                            DropdownMenuItem(text = { Text("문서 열기") }, enabled = !busy,
                                onClick = { fileMenu = false; request(onOpen) })
                            DropdownMenuItem(text = { Text("글꼴 추가") }, enabled = !busy && !dirty,
                                onClick = { fileMenu = false; onAddFont() })
                            HorizontalDivider()
                            DropdownMenuItem(text = { Text("다른 이름으로 저장") },
                                enabled = document?.editing?.canEdit == true && !busy,
                                onClick = { fileMenu = false; chooseSave() })
                            DropdownMenuItem(text = { Text("문서 닫기") }, enabled = document != null && !busy,
                                onClick = { fileMenu = false; request(onClose) })
                            Text(ready?.document?.editing?.reason?.takeIf(String::isNotBlank) ?: "변경 내용은 새 파일로 저장합니다.",
                                Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    for (name in listOf("편집", "보기", "입력", "서식", "표")) {
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
                        "편집", "서식" -> {
                            TextButton(onClick = { applyDraft { textMode = !textMode } }, enabled = document != null && !busy) {
                                Text(if (textMode) "쪽 편집" else "본문 복사")
                            }
                            for ((label, props) in listOf(
                                "굵게" to JSONObject().put("bold", true),
                                "기울임" to JSONObject().put("italic", true),
                                "밑줄" to JSONObject().put("underline", true),
                                "강조 해제" to JSONObject().put("bold", false).put("italic", false).put("underline", false))) {
                                TextButton(onClick = { mutateSelected("characterFormat", JSONObject(props.toString())) },
                                    enabled = canMutate) { Text(label) }
                            }
                            for ((label, alignment) in listOf("왼쪽" to "left", "가운데" to "center", "오른쪽" to "right", "양쪽" to "justify")) {
                                TextButton(onClick = { mutateSelected("paragraphFormat", JSONObject().put("alignment", alignment)) }, enabled = canFormatParagraph) { Text(label) }
                            }
                            TextButton(onClick = onAddFont, enabled = !busy && !dirty) { Text("글꼴 추가") }
                            TextButton(onClick = { formatDialog = "character" }, enabled = canMutate) { Text("글자 모양") }
                            TextButton(onClick = { formatDialog = "paragraph" }, enabled = canFormatParagraph) { Text("문단 모양") }
                            VerticalDivider(Modifier.height(24.dp))
                            TextButton(onClick = { if (pendingChanges) { draft = null; focusManager.clearFocus(); keyboard?.hide() } else applyDraft { selectedParagraph = null; selectedTextRun = null; onHistory(false) } }, enabled = (document?.editing?.canUndo == true || pendingChanges) && !busy) { Text("↶ 실행 취소") }
                            TextButton(onClick = { applyDraft { selectedParagraph = null; selectedTextRun = null; onHistory(true) } }, enabled = document?.editing?.canRedo == true && !busy && !pendingChanges) { Text("↷ 다시 실행") }
                            TextButton(onClick = { chooseSave() },
                                enabled = document?.editing?.canEdit == true && dirty && !busy) { Text("저장") }
                        }
                        "입력" -> {
                            TextButton(onClick = { insertDialog = "table" },
                                enabled = canInsert) { Text("표") }
                            TextButton(onClick = { insertDialog = "equation" },
                                enabled = canInsert) { Text("수식") }
                            TextButton(onClick = { mutateSelected("insertShape", JSONObject().put("offset", selectedOffset())) }, enabled = canInsert) { Text("사각형") }
                            TextButton(onClick = {
                                selectedTextRun?.takeIf { it.cellPath.isEmpty() }?.let { run ->
                                    val target = run.copy(start = selectedOffset(), text = "")
                                    draft = null; selectedParagraph = null; selectedTextRun = null
                                    focusManager.clearFocus(); keyboard?.hide(); onInsertPicture(target)
                                }
                            },
                                enabled = canInsert) { Text("그림") }
                            TextButton(onClick = {
                                mutateSelected("splitParagraph", JSONObject().put("offset", selectedOffset()))
                            }, enabled = canInsert) { Text("문단 나누기") }
                            Text("글자 위치 선택 · 적용으로 반영", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        "표" -> {
                            TextButton(onClick = { insertDialog = "table" }, enabled = canInsert) { Text("표 만들기") }
                            TextButton(onClick = { mutateSelected("insertRowBelow", JSONObject()) }, enabled = canEditTable) { Text("아래에 행 추가") }
                            TextButton(onClick = { mutateSelected("insertColumnRight", JSONObject()) }, enabled = canEditTable) { Text("오른쪽에 열 추가") }
                            TextButton(onClick = { mutateSelected("splitCell", JSONObject()) }, enabled = canEditTable) { Text("셀 나누기") }
                            TextButton(onClick = { deleteTableOperation = "deleteRow" }, enabled = canEditTable) { Text("행 지우기") }
                            TextButton(onClick = { deleteTableOperation = "deleteColumn" }, enabled = canEditTable) { Text("열 지우기") }
                            Text("표 안의 글자를 선택하세요", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        "보기" -> {
                            TextButton(onClick = { zoom = 1f; scope.launch { horizontal.scrollTo(0) } },
                                enabled = document != null && !textMode && !busy) { Text("폭 맞춤") }
                            TextButton(onClick = { applyDraft { textMode = !textMode } }, enabled = document != null && !busy) {
                                Text(if (textMode) "쪽 보기" else "본문 복사")
                            }
                            TextButton(onClick = { jumpToPage() }, enabled = document != null && !busy) { Text("쪽 이동") }
                            TextButton(onClick = onAddFont, enabled = !busy && !dirty) { Text("글꼴 추가") }
                        }
                    }
                }
                HorizontalDivider()
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {

                state is ReaderState.Empty -> Column(Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("문서를 열어 보세요", style = MaterialTheme.typography.titleLarge)
                    Text("HWP 3.x · HWP 5.x · HWPX\n원본 서식을 유지해 페이지를 이어서 표시합니다.",
                        Modifier.padding(vertical = 16.dp), style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = { request(onOpen) }) { Text("문서 열기") }
                    TextButton(onClick = onNew) { Text("새 문서") }
                }
                state is ReaderState.Loading && document == null -> Column(Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                    Text(state.message, Modifier.padding(top = 16.dp))
                }
                state is ReaderState.Error -> Column(Modifier.align(Alignment.Center).padding(24.dp)) {
                    Text(state.message, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = onOpen) { Text("다른 문서 열기") }
                }
                ready != null -> BoxWithConstraints(Modifier.fillMaxSize()) {
                    val pageWidth = (maxWidth - 24.dp) * zoom
                    val contentWidth = maxOf(maxWidth, pageWidth + 24.dp)
                    Box(Modifier.fillMaxSize().background(Color(0xFFE5E8EF))
                        .transformable(zoomGesture, canPan = { false }, enabled = !textMode)
                        .horizontalScroll(horizontal)) {
                        LazyColumn(Modifier.width(contentWidth).fillMaxHeight().testTag("document-pages"),
                            state = listState, contentPadding = PaddingValues(vertical = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally) {
                            items(ready.document.totalPages, key = { it }) { index ->
                                Column(Modifier.width(pageWidth)) {
                                    Text("${index + 1}쪽", Modifier.padding(bottom = 6.dp),
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    PageViewer(ready.document, index, textMode,
                                        Modifier.fillMaxWidth().border(1.dp, Color(0xFFCBD2DC)),
                                        editable = ready.document.editing.canEdit && !textMode && !busy,
                                        draft = draft, onDraftChanged = { draft = it }, onApplyDraft = { applyDraft() },
                                        onSelectTextRun = { run ->
                                            selectedTextRun = run
                                            selectedParagraph = EditorParagraph(run.section, run.paragraph, run.text, true)
                                        })
                                }
                            }
                        }
                    }
                }
            }
        }
        if (busy && document != null) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (draft != null) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).background(Color(0xFFEAF2FF)).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text(if (pendingChanges) "입력한 내용 적용 대기" else "글자 편집 중", Modifier.weight(1f),
                    style = MaterialTheme.typography.labelMedium)
                TextButton(onClick = { draft = null; focusManager.clearFocus(); keyboard?.hide() }, enabled = !busy) { Text("취소") }
                TextButton(onClick = { applyDraft() }, enabled = !busy) { Text("적용") }
            }
        }
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().height(48.dp).background(Color.White).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { jumpToPage() }, enabled = document != null && !busy,
                modifier = Modifier.testTag("page-status"), contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text(if (document == null) "문서 없음" else "$currentPage / ${document.totalPages}쪽",
                    style = MaterialTheme.typography.labelMedium)
            }
            Text(ready?.message ?: when {
                document == null -> "문서 없음"
                dirty -> "저장하지 않은 변경"
                document.editing.canEdit -> "편집 가능"
                else -> "읽기 전용"
            }, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { zoom = (zoom / 1.25f).coerceAtLeast(.5f) },
                enabled = document != null && !textMode && !busy, modifier = Modifier.width(48.dp).semantics {
                    contentDescription = "축소"
                }, contentPadding = PaddingValues(0.dp)) { Text("−") }
            TextButton(onClick = { zoom = 1f; scope.launch { horizontal.scrollTo(0) } },
                enabled = document != null && !textMode && !busy, contentPadding = PaddingValues(horizontal = 4.dp)) {
                Text("${(zoom * 100).toInt()}%", style = MaterialTheme.typography.labelMedium)
            }
            TextButton(onClick = { zoom = (zoom * 1.25f).coerceAtMost(5f) },
                enabled = document != null && !textMode && !busy, modifier = Modifier.width(48.dp).semantics {
                    contentDescription = "확대"
                }, contentPadding = PaddingValues(0.dp)) { Text("+") }
        }
    }
    if (deleteTableOperation.isNotEmpty()) {
        val operation = deleteTableOperation
        AlertDialog(onDismissRequest = { deleteTableOperation = "" },
            title = { Text(if (operation == "deleteRow") "표 행 지우기" else "표 열 지우기") },
            text = { Text("선택한 셀이 포함된 ${if (operation == "deleteRow") "행" else "열"}과 그 안의 내용을 지웁니다. 실행 취소로 복원할 수 있습니다.") },
            confirmButton = { TextButton(enabled = canEditTable, onClick = {
                mutateSelected(operation, JSONObject()); deleteTableOperation = ""
            }) { Text("지우기") } },
            dismissButton = { TextButton(onClick = { deleteTableOperation = "" }) { Text("취소") } })
    }
    if (saveDialog && ready != null) {
        val validName = saveBase.isNotBlank() && saveBase.none { it == '/' || it == '\\' || it.code < 32 }
        AlertDialog(onDismissRequest = { saveDialog = false }, title = { Text("다른 이름으로 저장") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(saveBase, { saveBase = it.take(120) }, label = { Text("파일 이름") }, singleLine = true)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(saveFormat == "hwp", { saveFormat = "hwp" }); Text("HWP 5")
                    Spacer(Modifier.width(8.dp))
                    RadioButton(saveFormat == "hwpx", { saveFormat = "hwpx" }); Text("HWPX")
                }
                Text("HWP 3 문서는 HWP 5 또는 HWPX로 저장합니다.", style = MaterialTheme.typography.bodySmall)
            } },
            confirmButton = { TextButton(enabled = validName && !busy, onClick = {
                val name = "$saveBase.$saveFormat"
                saveDialog = false
                if (pendingChanges) { pendingSaveName = name; applyDraft() }
                else applyDraft { onSave(name) }
            }) { Text("저장 위치 선택") } },
            dismissButton = { TextButton(onClick = { saveDialog = false }) { Text("취소") } })
    }
    if (formatDialog.isNotEmpty()) {
        val character = formatDialog == "character"
        val size = fontSize.toFloatOrNull()?.takeIf { it.isFinite() && it in 1f..200f }
        val colorValid = Regex("#[0-9a-fA-F]{6}").matches(textColor)
        val spacing = lineSpacing.toIntOrNull()?.takeIf { it in 50..500 }
        val valid = if (character) size != null && colorValid else spacing != null
        AlertDialog(onDismissRequest = { formatDialog = "" },
            title = { Text(if (character) "글자 모양" else "문단 모양") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (character) {
                    OutlinedTextField(fontSize, { fontSize = it.take(6) }, label = { Text("크기 (1~200 pt)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true)
                    OutlinedTextField(textColor, { textColor = it.take(7) }, label = { Text("글자 색 (#RRGGBB)") }, singleLine = true)
                    Text("선택한 글자 범위에 적용합니다. 범위가 없으면 선택한 글줄에 적용합니다.", style = MaterialTheme.typography.bodySmall)
                } else {
                    OutlinedTextField(lineSpacing, { lineSpacing = it.filter(Char::isDigit).take(3) },
                        label = { Text("줄 간격 (50~500 %)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    Text("선택한 문단에 적용합니다.", style = MaterialTheme.typography.bodySmall)
                }
            } },
            confirmButton = { TextButton(enabled = valid && canMutate && (character || canFormatParagraph), onClick = {
                if (character) mutateSelected("characterFormat", JSONObject().put("fontSize", (size!! * 100).roundToInt())
                    .put("textColor", textColor))
                else mutateSelected("paragraphFormat", JSONObject().put("lineSpacing", spacing).put("lineSpacingType", "Percent"))
                formatDialog = ""
            }) { Text("적용") } },
            dismissButton = { TextButton(onClick = { formatDialog = "" }) { Text("취소") } })
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
            confirmButton = { TextButton(enabled = valid && canInsert, onClick = {
                if (isTable) mutateSelected("insertTable", JSONObject()
                    .put("rows", tableRows.toInt()).put("columns", tableColumns.toInt()).put("offset", selectedOffset()))
                else mutateSelected("insertEquation", JSONObject().put("script", equationScript).put("offset", selectedOffset()))
                insertDialog = ""
            }) { Text("삽입") } },
            dismissButton = { TextButton(onClick = { insertDialog = "" }) { Text("취소") } })
    }
    if (help) {
        AlertDialog(onDismissRequest = { help = false }, title = { Text("문서 사용 안내") },
            text = { Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) { Text("위아래로 스크롤해 다음 쪽을 읽습니다. 두 손가락이나 아래 배율 버튼으로 확대하고, 확대된 문서는 좌우로 이동할 수 있습니다.\n\n파일 메뉴에서 문서와 글꼴을 열 수 있습니다. 원본 글꼴이 없으면 대체 글꼴을 사용합니다.\n\n쪽에서 글자를 누르면 해당 위치에서 바로 수정할 수 있습니다. 키보드 Enter로 새 문단을 입력하고 적용을 누르면 내용을 반영합니다. 편집·서식 탭에서 굵게·기울임·밑줄과 문단 정렬을 적용하고, 입력·표 탭에서 표·수식·사각형 도형·그림을 추가할 수 있습니다. 변경은 실행 취소·다시 실행과 새 HWP/HWPX 저장을 지원합니다. HWP 3 문서는 편집 후 HWP 5 또는 HWPX로 저장합니다. 기존 그림·도형·차트의 세부 수정과 공식 한글의 모든 기능은 지원하지 않습니다.\n\n본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다." +
                if (document?.warnings?.isNotEmpty() == true) "\n\n문서 경고:\n" + document.warnings.take(10).joinToString("\n") else "") } },
            confirmButton = { TextButton(onClick = { help = false }) { Text("확인") } })
    }
    discardAction?.let { action ->
        AlertDialog(onDismissRequest = { discardAction = null }, title = { Text("저장하지 않은 변경") },
            text = { Text("편집한 내용을 버리고 계속할까요? 저장하려면 취소를 누른 뒤 저장을 선택하세요.") },
            confirmButton = { TextButton(onClick = {
                discardAction = null
                draft = null
                focusManager.clearFocus()
                keyboard?.hide()
                onClose()
                action()
            }) { Text("변경 버리기") } },
            dismissButton = { TextButton(onClick = { discardAction = null }) { Text("취소") } })
    }
}
