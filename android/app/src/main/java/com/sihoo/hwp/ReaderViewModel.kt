package com.sihoo.hwp

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface ReaderState {
    data object Empty : ReaderState
    data object Loading : ReaderState
    data class Ready(val name: String, val document: ReadDocument) : ReaderState
    data class Error(val message: String) : ReaderState
}

class ReaderViewModel(application: Application) : AndroidViewModel(application) {
    private val mutableState = MutableStateFlow<ReaderState>(ReaderState.Empty)
    val state = mutableState.asStateFlow()

    fun open(uri: Uri) {
        if (mutableState.value == ReaderState.Loading) return
        mutableState.value = ReaderState.Loading
        viewModelScope.launch {
            try {
                mutableState.value = withContext(Dispatchers.IO) {
                    val resolver = getApplication<Application>().contentResolver
                    val name = resolver.query(
                        uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null,
                    )?.use { cursor ->
                        if (cursor.moveToFirst()) cursor.getString(0) else null
                    } ?: "한글 문서"
                    val bytes = resolver.openInputStream(uri)?.use { input ->
                        val output = ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            require(output.size().toLong() + count <= MAX_FILE_BYTES) {
                                "32 MB 이하의 문서를 선택해 주세요."
                            }
                            output.write(buffer, 0, count)
                        }
                        output.toByteArray()
                    } ?: error("파일을 열 수 없습니다.")
                    ReaderState.Ready(name, NativeReader.read(bytes))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: LinkageError) {
                mutableState.value = ReaderState.Error(
                    "문서 엔진을 불러올 수 없습니다. 지원하는 기기용 APK인지 확인해 주세요.",
                )
            } catch (error: Exception) {
                mutableState.value = ReaderState.Error(
                    error.message ?: "문서를 읽지 못했습니다. 다른 파일을 선택해 주세요.",
                )
            }
        }
    }

    companion object {
        private const val MAX_FILE_BYTES = 32L * 1024 * 1024
    }
}
