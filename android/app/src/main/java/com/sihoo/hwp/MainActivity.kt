package com.sihoo.hwp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF2457C5))) { ReaderScreen() }
        }
    }
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReaderScreen(reader: ReaderViewModel = viewModel()) {
    val state by reader.state.collectAsStateWithLifecycle()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(reader::open) }
    val fonts = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(reader::addFont) }
    Scaffold(topBar = { TopAppBar(title = { Text("한글 읽기") }) }) { insets ->
        Column(Modifier.fillMaxSize().padding(insets).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { picker.launch(arrayOf("*/*")) },
                    enabled = state !is ReaderState.Loading, modifier = Modifier.weight(1f)) { Text("문서 열기") }
                OutlinedButton(onClick = { fonts.launch(arrayOf("*/*")) },
                    enabled = state !is ReaderState.Loading) { Text("글꼴 추가") }
            }
            when (val current = state) {
                ReaderState.Empty -> Text("HWP 3.x · HWP 5.x · HWPX\n문서를 선택하면 수식·표·그림·도형·도표를 포함한 페이지를 표시합니다.",
                    Modifier.padding(vertical = 24.dp))
                is ReaderState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Text(current.message, Modifier.padding(top = 16.dp))
                    }
                }
                is ReaderState.Error -> Text(current.message, Modifier.padding(24.dp), color = MaterialTheme.colorScheme.error)
                is ReaderState.Ready -> DocumentContent(current, Modifier.weight(1f))
            }
        }
    }
}
@Composable
private fun DocumentContent(ready: ReaderState.Ready, modifier: Modifier) {
    var index by rememberSaveable(ready.document.id) { mutableIntStateOf(0) }
    var zoom by remember(ready.document.id, index) { mutableFloatStateOf(1f) }
    var textMode by rememberSaveable(ready.document.id) { mutableStateOf(false) }
    var showJump by remember { mutableStateOf(false) }
    var jump by remember(ready.document.id, index) { mutableStateOf((index + 1).toString()) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(ready.name, style = MaterialTheme.typography.titleMedium, maxLines = 1)
        Text("같은 글꼴이 없으면 대체 글꼴을 사용합니다. TTF·OTF·TTC를 추가할 수 있습니다.",
            style = MaterialTheme.typography.bodySmall)
        if (ready.document.warnings.isNotEmpty()) {
            Text("문서 구조 경고 ${ready.document.warnings.size}건: 일부 배치가 다를 수 있습니다.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = { index-- }, enabled = index > 0) { Text("이전") }
            TextButton(onClick = { showJump = true }) { Text("${index + 1} / ${ready.document.totalPages}쪽") }
            TextButton(onClick = { index++ }, enabled = index + 1 < ready.document.totalPages) { Text("다음") }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { zoom = (zoom / 1.5f).coerceAtLeast(1f) }, enabled = !textMode) { Text("−") }
            TextButton(onClick = { zoom = 1f }, enabled = !textMode) { Text("${(zoom * 100).toInt()}%") }
            TextButton(onClick = { zoom = (zoom * 1.5f).coerceAtMost(5f) }, enabled = !textMode) { Text("+") }
            TextButton(onClick = { textMode = !textMode }) { Text(if (textMode) "원본 보기" else "텍스트 복사") }
        }
        key(ready.document.id, index) {
            PageViewer(ready.document, index, zoom, textMode, { zoom = it }, Modifier.weight(1f).fillMaxWidth())
        }
    }
    if (showJump) {
        AlertDialog(onDismissRequest = { showJump = false }, title = { Text("쪽 이동") },
            text = { OutlinedTextField(jump, { jump = it.filter(Char::isDigit).take(6) },
                singleLine = true, label = { Text("1 ~ ${ready.document.totalPages}") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)) },
            confirmButton = { TextButton(onClick = {
                jump.toIntOrNull()?.takeIf { it in 1..ready.document.totalPages }?.let { index = it - 1; showJump = false }
            }) { Text("이동") } },
            dismissButton = { TextButton(onClick = { showJump = false }) { Text("취소") } })
    }
}
