package com.sihoo.hwp

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface ReaderState {
    data object Empty : ReaderState
    data class Loading(val message: String) : ReaderState
    data class Ready(val name: String, val document: ReadDocument) : ReaderState
    data class Error(val message: String) : ReaderState
}
class ReaderViewModel(application: Application) : AndroidViewModel(application) {
    private val mutableState = MutableStateFlow<ReaderState>(ReaderState.Empty)
    val state = mutableState.asStateFlow()
    private val handle = AtomicLong()
    @Volatile private var disposed = false
    private var lastUri: Uri? = null

    fun open(uri: Uri) {
        if (mutableState.value is ReaderState.Loading) return
        lastUri = uri
        mutableState.value = ReaderState.Loading("문서의 페이지 배치를 읽고 있습니다…")
        viewModelScope.launch {
            try {
                mutableState.value = withContext(Dispatchers.IO) {
                    NativeReader.close(handle.getAndSet(0))
                    val app = getApplication<Application>()
                    val resolver = app.contentResolver
                    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                        ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "한글 문서"
                    val bytes = resolver.openInputStream(uri)?.use { it.readBounded(32 * 1024 * 1024) }
                        ?: error("파일을 열 수 없습니다.")
                    val document = NativeReader.open(bytes, FontStore.prepare(app), File(app.cacheDir, "pages"))
                    handle.set(document.id)
                    if (disposed) {
                        NativeReader.close(handle.getAndSet(0))
                        throw CancellationException()
                    }
                    ReaderState.Ready(name, document)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: LinkageError) {
                mutableState.value = ReaderState.Error("문서 엔진을 불러올 수 없습니다. 앱을 다시 설치해 주세요.")
            } catch (error: Exception) {
                mutableState.value = ReaderState.Error(error.message ?: "문서를 읽지 못했습니다.")
            }
        }
    }
    fun addFont(uri: Uri) {
        if (mutableState.value is ReaderState.Loading) return
        mutableState.value = ReaderState.Loading("글꼴을 추가하고 있습니다…")
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { FontStore.import(getApplication(), uri) }
                mutableState.value = ReaderState.Empty
                lastUri?.let(::open)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutableState.value = ReaderState.Error(error.message ?: "글꼴을 추가하지 못했습니다.") }
        }
    }
    override fun onCleared() {
        disposed = true
        val id = handle.getAndSet(0)
        // Release native resources off the UI thread, including after a cancelled open.
        CoroutineScope(Dispatchers.IO).launch { NativeReader.close(id) }
        super.onCleared()
    }
}
