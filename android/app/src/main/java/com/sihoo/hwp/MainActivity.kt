package com.sihoo.hwp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(
                colorScheme = lightColorScheme(
                    primary = Color(0xFF2457C5),
                    surface = Color(0xFFF7F8FC),
                ),
            ) {
                ReaderScreen()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReaderScreen(reader: ReaderViewModel = viewModel()) {
    val state by reader.state.collectAsStateWithLifecycle()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(reader::open)
    }
    Scaffold(
        topBar = { TopAppBar(title = { Text("한글 읽기") }) },
    ) { insets ->
        Column(
            modifier = Modifier.fillMaxSize().padding(insets).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Button(
                // HWP MIME types vary between providers; detect the actual file in Rust.
                onClick = { picker.launch(arrayOf("*/*")) },
                enabled = state != ReaderState.Loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("문서 열기") }
            Text(
                "HWP 3.x · HWP 5.x · HWPX / 텍스트 읽기",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            when (val current = state) {
                ReaderState.Empty -> Message(
                    "한글 문서를 선택해 주세요",
                    "기기나 클라우드 저장소에서 문서를 열 수 있습니다.\n첫 버전은 원본 서식 대신 추출된 텍스트를 표시합니다.",
                )
                ReaderState.Loading -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Text("문서를 읽고 있습니다…", Modifier.padding(top = 16.dp))
                    }
                }
                is ReaderState.Error -> Message("문서를 열지 못했습니다", current.message)
                is ReaderState.Ready -> DocumentContent(current)
            }
        }
    }
}

@Composable
private fun Message(title: String, message: String) {
    Card(Modifier.fillMaxWidth()) {
        Column(
            Modifier.padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(message, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun DocumentContent(state: ReaderState.Ready) {
    // ponytail: text cards only; replay PageLayerTree when original layout is required.
    LazyColumn(
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(state.name, style = MaterialTheme.typography.titleLarge)
                Text(
                    "${state.document.format} · ${state.document.totalPages}쪽",
                    style = MaterialTheme.typography.labelLarge,
                )
                Text(
                    "표·그림·수식의 원본 모양은 이 버전에서 표시하지 않습니다.",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (state.document.truncated) {
                    Text(
                        "큰 문서의 일부만 표시했습니다. 최대 200쪽·100만 글자까지 읽을 수 있습니다.",
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
        items(state.document.pages, key = { it.index }) { page ->
            Card(Modifier.fillMaxWidth()) {
                Column(
                    Modifier.padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("${page.index + 1}쪽", style = MaterialTheme.typography.labelLarge)
                    if (page.warning != null) {
                        Text(page.warning, color = MaterialTheme.colorScheme.error)
                    }
                    SelectionContainer {
                        Text(
                            page.text.ifBlank { "추출할 텍스트가 없습니다." },
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                }
            }
        }
    }
}
