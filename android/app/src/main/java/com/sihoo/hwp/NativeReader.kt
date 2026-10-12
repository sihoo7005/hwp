package com.sihoo.hwp

import org.json.JSONObject

data class DocumentPage(val index: Int, val text: String, val warning: String?)
data class ReadDocument(
    val format: String,
    val totalPages: Int,
    val pages: List<DocumentPage>,
    val truncated: Boolean,
)

object NativeReader {
    init {
        System.loadLibrary("hwp_reader")
    }

    private external fun readDocument(data: ByteArray): String

    fun read(data: ByteArray): ReadDocument {
        val result = JSONObject(readDocument(data))
        if (!result.getBoolean("ok")) {
            throw IllegalArgumentException(result.getString("message"))
        }
        val pages = result.getJSONArray("pages")
        return ReadDocument(
            format = result.getString("format"),
            totalPages = result.getInt("totalPages"),
            pages = List(pages.length()) { index ->
                val page = pages.getJSONObject(index)
                DocumentPage(
                    index = page.getInt("index"),
                    text = page.getString("text"),
                    warning = page.optString("warning").takeIf { it.isNotBlank() },
                )
            },
            truncated = result.getBoolean("truncated"),
        )
    }
}
