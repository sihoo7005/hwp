package com.sihoo.hwp

import java.io.File
import org.json.JSONArray
import org.json.JSONObject

data class ReadDocument(
    val id: Long,
    val format: String,
    val totalPages: Int,
    val warnings: List<String>,
    val editing: EditorState,
    val revision: Int = 0,
)
data class EditorParagraph(val section: Int, val paragraph: Int, val text: String, val editable: Boolean)
data class EditorState(
    val canEdit: Boolean,
    val reason: String,
    val paragraphs: List<EditorParagraph>,
    val dirty: Boolean,
    val canUndo: Boolean,
    val canRedo: Boolean,
    val totalPages: Int,
)
data class RenderedPage(val file: File, val layout: File, val text: String, val warnings: List<String>)

object NativeReader {
    init { System.loadLibrary("hwp_reader") }
    private external fun openDocument(data: ByteArray, fonts: String, cache: String): String
    private external fun renderPage(id: Long, index: Int): String
    private external fun editParagraph(id: Long, section: Int, paragraph: Int, before: String, after: String): String
    private external fun historyNative(id: Long, redo: Boolean): String
    private external fun exportDocument(id: Long): ByteArray
    private external fun markSaved(id: Long)
    private external fun closeDocument(id: Long)
    private fun result(value: String): JSONObject {
        val result = JSONObject(value)
        require(result.getBoolean("ok")) { result.getString("message") }
        return result
    }
    fun open(data: ByteArray, fonts: File, cache: File): ReadDocument {
        val value = result(openDocument(data, fonts.absolutePath, cache.absolutePath))
        return ReadDocument(value.getLong("id"), value.getString("format"),
            value.getInt("totalPages"), value.getJSONArray("warnings").strings(),
            editorState(value.getJSONObject("editing")))
    }
    private fun editorState(state: JSONObject): EditorState {
        return EditorState(state.optBoolean("canEdit"), state.optString("reason"),
            state.optJSONArray("paragraphs")?.objects()?.map {
                EditorParagraph(it.getInt("section"), it.getInt("paragraph"), it.getString("text"), it.getBoolean("editable"))
            }.orEmpty(), state.optBoolean("dirty"), state.optBoolean("canUndo"), state.optBoolean("canRedo"),
            state.optInt("totalPages"))
    }
    fun edit(id: Long, paragraph: EditorParagraph, text: String): EditorState {
        val value = result(editParagraph(id, paragraph.section, paragraph.paragraph, paragraph.text, text))
        return editorState(value.getJSONObject("state"))
    }
    fun history(id: Long, redo: Boolean): EditorState {
        val value = result(historyNative(id, redo))
        return editorState(value.getJSONObject("state"))
    }
    fun export(id: Long): ByteArray = exportDocument(id)
    fun markSavedDocument(id: Long) = markSaved(id)
    fun page(id: Long, index: Int): RenderedPage {
        val value = result(renderPage(id, index))
        return RenderedPage(File(value.getString("svgPath")), File(value.getString("layoutPath")), value.getString("text"),
            value.getJSONArray("warnings").strings())
    }
    fun close(id: Long) { if (id != 0L) closeDocument(id) }
    private fun JSONArray.strings() = List(length()) { getString(it) }
    private fun JSONArray.objects() = List(length()) { getJSONObject(it) }
}
