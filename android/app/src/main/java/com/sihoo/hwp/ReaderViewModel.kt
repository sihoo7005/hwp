package com.sihoo.hwp

import android.app.Application
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject
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
    data class Ready(val name: String, val document: ReadDocument, val message: String? = null) : ReaderState
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
        val previous = mutableState.value as? ReaderState.Ready
        if (previous?.document?.editing?.dirty == true) return
        mutableState.value = ReaderState.Loading("문서의 페이지 배치를 읽고 있습니다…")
        viewModelScope.launch {
            try {
                val opened = withContext(Dispatchers.IO) {
                    val app = getApplication<Application>()
                    val resolver = app.contentResolver
                    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                        ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "한글 문서"
                    val bytes = resolver.openInputStream(uri)?.use { it.readBounded(32 * 1024 * 1024) }
                        ?: error("파일을 열 수 없습니다.")
                    val document = NativeReader.open(bytes, FontStore.prepare(app), File(app.cacheDir, "pages"))
                    if (disposed) {
                        NativeReader.close(document.id)
                        throw CancellationException()
                    }
                    ReaderState.Ready(name, document)
                }
                val old = handle.getAndSet(opened.document.id)
                withContext(Dispatchers.IO) { NativeReader.close(old) }
                lastUri = uri
                mutableState.value = opened
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: LinkageError) {
                mutableState.value = previous ?: ReaderState.Error("문서 엔진을 불러올 수 없습니다. 앱을 다시 설치해 주세요.")
            } catch (error: Exception) {
                mutableState.value = previous ?: ReaderState.Error(error.message ?: "문서를 읽지 못했습니다.")
            }
        }
    }
    fun addFont(uri: Uri) {
        if (mutableState.value is ReaderState.Loading) return
        val previous = mutableState.value as? ReaderState.Ready
        if (previous?.document?.editing?.dirty == true) return
        mutableState.value = ReaderState.Loading("글꼴을 추가하고 있습니다…")
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { FontStore.import(getApplication(), uri) }
                mutableState.value = ReaderState.Empty
                lastUri?.let(::open)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                mutableState.value = previous?.copy(message = error.message ?: "글꼴을 추가하지 못했습니다.")
                    ?: ReaderState.Error(error.message ?: "글꼴을 추가하지 못했습니다.")
            }
        }
    }
    fun edit(paragraph: EditorParagraph, text: String) {
        val ready = mutableState.value as? ReaderState.Ready ?: return
        if (!ready.document.editing.canEdit || mutableState.value is ReaderState.Loading) return
        mutableState.value = ReaderState.Loading("문단을 수정하고 있습니다…")
        viewModelScope.launch {
            try {
                val editing = withContext(Dispatchers.IO) { NativeReader.edit(ready.document.id, paragraph, text) }
                mutableState.value = ready.copy(document = ready.document.copy(
                    totalPages = editing.totalPages, editing = editing, revision = ready.document.revision + 1), message = null)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutableState.value = ready.copy(message = error.message ?: "문단을 수정하지 못했습니다.") }
        }
    }
    fun mutate(paragraph: EditorParagraph, operation: String, properties: JSONObject = JSONObject(),
        rows: Int = 2, columns: Int = 2, script: String = "x = y") {
        val ready = mutableState.value as? ReaderState.Ready ?: return
        if (!ready.document.editing.canEdit || mutableState.value is ReaderState.Loading) return
        val command = JSONObject().put("operation", operation).put("section", paragraph.section)
            .put("paragraph", paragraph.paragraph).put("properties", properties)
            .put("rows", properties.optInt("rows", rows)).put("columns", properties.optInt("columns", columns))
            .put("script", properties.optString("script", script))
        mutableState.value = ReaderState.Loading("문서를 수정하고 있습니다…")
        viewModelScope.launch {
            try {
                val editing = withContext(Dispatchers.IO) { NativeReader.mutate(ready.document.id, command) }
                mutableState.value = ready.copy(document = ready.document.copy(
                    totalPages = editing.totalPages, editing = editing, revision = ready.document.revision + 1), message = null)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutableState.value = ready.copy(message = error.message ?: "문서를 수정하지 못했습니다.") }
        }
    }
    fun insertPicture(paragraph: EditorParagraph, uri: Uri) {
        val ready = mutableState.value as? ReaderState.Ready ?: return
        if (!ready.document.editing.canEdit || mutableState.value is ReaderState.Loading) return
        mutableState.value = ReaderState.Loading("그림을 삽입하고 있습니다…")
        viewModelScope.launch {
            try {
                val editing = withContext(Dispatchers.IO) {
                    val app = getApplication<Application>()
                    val bytes = app.contentResolver.openInputStream(uri)?.use { it.readBounded(8 * 1024 * 1024) }
                        ?: error("그림 파일을 읽을 수 없습니다.")
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "그림 크기를 읽을 수 없습니다." }
                    val name = app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                        ?.use { if (it.moveToFirst()) it.getString(0) else null }.orEmpty()
                    val mimeExtension = when (app.contentResolver.getType(uri)?.lowercase()) {
                        "image/jpeg" -> "jpg"
                        "image/png" -> "png"
                        "image/bmp" -> "bmp"
                        "image/gif" -> "gif"
                        else -> ""
                    }
                    val extension = name.substringAfterLast('.', mimeExtension.ifBlank { "png" }).lowercase()
                    require(bounds.outWidth.toLong() * bounds.outHeight <= 16_000_000) { "그림은 1,600만 화소 이하로 선택해 주세요." }
                    NativeReader.insertPicture(ready.document.id, paragraph.section, paragraph.paragraph,
                        bytes, extension, bounds.outWidth, bounds.outHeight)
                }
                mutableState.value = ready.copy(document = ready.document.copy(
                    totalPages = editing.totalPages, editing = editing, revision = ready.document.revision + 1), message = null)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutableState.value = ready.copy(message = error.message ?: "그림을 삽입하지 못했습니다.") }
        }
    }
    fun history(redo: Boolean) {
        val ready = mutableState.value as? ReaderState.Ready ?: return
        val canRun = if (redo) ready.document.editing.canRedo else ready.document.editing.canUndo
        if (!canRun || mutableState.value is ReaderState.Loading) return
        mutableState.value = ReaderState.Loading("문서 이력을 복원하고 있습니다…")
        viewModelScope.launch {
            try {
                val editing = withContext(Dispatchers.IO) { NativeReader.history(ready.document.id, redo) }
                mutableState.value = ready.copy(document = ready.document.copy(
                    totalPages = editing.totalPages, editing = editing, revision = ready.document.revision + 1), message = null)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutableState.value = ready.copy(message = error.message ?: "문서 이력을 복원하지 못했습니다.") }
        }
    }
    fun save(uri: Uri) {
        val ready = mutableState.value as? ReaderState.Ready ?: return
        if (!ready.document.editing.canEdit) return
        mutableState.value = ReaderState.Loading("문서를 저장하고 확인하고 있습니다…")
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val bytes = NativeReader.export(ready.document.id)
                    getApplication<Application>().contentResolver.openOutputStream(uri, "w")
                        ?.use { it.write(bytes) } ?: error("저장 위치에 쓸 수 없습니다.")
                    NativeReader.markSavedDocument(ready.document.id)
                }
                mutableState.value = ready.copy(document = ready.document.copy(
                    editing = ready.document.editing.copy(dirty = false)), message = "새 파일로 저장했습니다.")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutableState.value = ready.copy(message = error.message ?: "문서를 저장하지 못했습니다.") }
        }
    }
    fun close() {
        if (mutableState.value is ReaderState.Loading) return
        lastUri = null
        val id = handle.getAndSet(0)
        mutableState.value = ReaderState.Empty
        viewModelScope.launch(Dispatchers.IO) { NativeReader.close(id) }
    }
    override fun onCleared() {
        disposed = true
        val id = handle.getAndSet(0)
        // Release native resources off the UI thread, including after a cancelled open.
        CoroutineScope(Dispatchers.IO).launch { NativeReader.close(id) }
        super.onCleared()
    }
}
