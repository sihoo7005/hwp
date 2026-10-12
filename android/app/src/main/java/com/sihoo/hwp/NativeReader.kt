package com.sihoo.hwp

import java.io.File
import org.json.JSONArray
import org.json.JSONObject

data class ReadDocument(val id: Long, val format: String, val totalPages: Int, val warnings: List<String>)
data class RenderedPage(val file: File, val layout: File, val text: String, val warnings: List<String>)

object NativeReader {
    init { System.loadLibrary("hwp_reader") }
    private external fun openDocument(data: ByteArray, fonts: String, cache: String): String
    private external fun renderPage(id: Long, index: Int): String
    private external fun closeDocument(id: Long)
    private fun result(value: String): JSONObject {
        val result = JSONObject(value)
        require(result.getBoolean("ok")) { result.getString("message") }
        return result
    }
    fun open(data: ByteArray, fonts: File, cache: File): ReadDocument {
        val value = result(openDocument(data, fonts.absolutePath, cache.absolutePath))
        return ReadDocument(value.getLong("id"), value.getString("format"),
            value.getInt("totalPages"), value.getJSONArray("warnings").strings())
    }
    fun page(id: Long, index: Int): RenderedPage {
        val value = result(renderPage(id, index))
        return RenderedPage(File(value.getString("svgPath")), File(value.getString("layoutPath")), value.getString("text"),
            value.getJSONArray("warnings").strings())
    }
    fun close(id: Long) { if (id != 0L) closeDocument(id) }
    private fun JSONArray.strings() = List(length()) { getString(it) }
}
