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
data class EditorObject(val section: Int, val paragraph: Int, val controlIndex: Int, val kind: String)
data class PageTextRun(val section: Int, val paragraph: Int, val start: Int, val text: String,
    val x: Float, val y: Float, val width: Float, val height: Float,
    val cellPath: List<Triple<Int, Int, Int>>)
data class EditorState(
    val canEdit: Boolean,
    val reason: String,
    val paragraphs: List<EditorParagraph>,
    val objects: List<EditorObject>,
    val dirty: Boolean,
    val canUndo: Boolean,
    val canRedo: Boolean,
    val totalPages: Int,
)
data class RenderedPage(val file: File, val layout: File, val textRuns: List<PageTextRun>,
    val text: String, val warnings: List<String>)

object NativeReader {
    init { System.loadLibrary("hwp_reader") }
    private external fun openDocument(data: ByteArray, fonts: String, cache: String): String
    private external fun renderPage(id: Long, index: Int): String
    private external fun editParagraph(id: Long, section: Int, paragraph: Int, before: String, after: String): String
    private external fun historyNative(id: Long, redo: Boolean): String
    private external fun mutateNative(id: Long, command: String): String
    private external fun editTextRunNative(id: Long, command: String): String
    private external fun insertPictureNative(id: Long, section: Int, paragraph: Int, offset: Int,
        data: ByteArray, extension: String, width: Int, height: Int): String
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
            }.orEmpty(), state.optJSONArray("objects")?.objects()?.map {
                EditorObject(it.getInt("section"), it.getInt("paragraph"), it.getInt("controlIndex"), it.getString("kind"))
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
    fun mutate(id: Long, command: JSONObject): EditorState {
        val value = result(mutateNative(id, command.toString()))
        return editorState(value.getJSONObject("state"))
    }
    fun editTextRun(id: Long, run: PageTextRun, text: String): EditorState {
        val path = JSONArray().apply { run.cellPath.forEach { put(JSONArray().put(it.first).put(it.second).put(it.third)) } }
        val command = JSONObject().put("section", run.section).put("paragraph", run.paragraph)
            .put("start", run.start).put("before", run.text).put("after", text).put("cellPath", path)
        val value = result(editTextRunNative(id, command.toString()))
        return editorState(value.getJSONObject("state"))
    }
    fun insertPicture(id: Long, run: PageTextRun, data: ByteArray,
        extension: String, width: Int, height: Int): EditorState {
        val offset = run.start + run.text.codePointCount(0, run.text.length)
        val value = result(insertPictureNative(id, run.section, run.paragraph, offset, data, extension, width, height))
        return editorState(value.getJSONObject("state"))
    }
    fun export(id: Long): ByteArray = exportDocument(id)
    fun markSavedDocument(id: Long) = markSaved(id)
    fun page(id: Long, index: Int): RenderedPage {
        val value = result(renderPage(id, index))
        val runs = JSONArray(File(value.getString("textRunsPath")).readText()).objects().map { item ->
            val path = item.getJSONArray("cellPath")
            PageTextRun(item.getInt("section"), item.getInt("paragraph"), item.getInt("start"), item.getString("text"),
                item.getDouble("x").toFloat(), item.getDouble("y").toFloat(), item.getDouble("width").toFloat(),
                item.getDouble("height").toFloat(), List(path.length()) { i ->
                    val entry = path.getJSONArray(i)
                    Triple(entry.getInt(0), entry.getInt(1), entry.getInt(2))
                })
        }
        return RenderedPage(File(value.getString("svgPath")), File(value.getString("layoutPath")), runs, value.getString("text"),
            value.getJSONArray("warnings").strings())
    }
    fun close(id: Long) { if (id != 0L) closeDocument(id) }
    private fun JSONArray.strings() = List(length()) { getString(it) }
    private fun JSONArray.objects() = List(length()) { getJSONObject(it) }
}
