package com.sihoo.hwp

import android.content.Context
import android.graphics.Typeface
import android.net.Uri
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

internal fun InputStream.readBounded(maxBytes: Int): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        require(output.size().toLong() + count <= maxBytes) {
            "파일 크기는 ${maxBytes / (1024 * 1024)} MB 이하여야 합니다."
        }
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}
object FontStore {
    fun prepare(context: Context): File {
        val root = File(context.filesDir, "document-fonts")
        File(root, "custom").mkdirs()
        val bundled = File(root, "bundled").apply { mkdirs() }
        val names = context.assets.list("fonts").orEmpty().filter { it.endsWith(".ttf") || it.endsWith(".otf") }
        check(names.isNotEmpty()) { "기본 글꼴이 없습니다. 앱을 다시 설치해 주세요." }
        for (name in names) {
            val destination = File(bundled, name)
            if (!destination.exists()) {
                context.assets.open("fonts/$name").use { input ->
                    destination.outputStream().use { output -> input.copyTo(output) }
                }
            }
        }
        return root
    }
    fun import(context: Context, uri: Uri) {
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBounded(16 * 1024 * 1024) }
            ?: error("글꼴 파일을 열 수 없습니다.")
        require(bytes.size >= 4) { "올바른 글꼴 파일이 아닙니다." }
        val signature = bytes.take(4)
        val extension = when {
            signature == listOf<Byte>(0, 1, 0, 0) -> "ttf"
            signature == "OTTO".toByteArray().toList() -> "otf"
            signature == "ttcf".toByteArray().toList() -> "ttc"
            else -> error("TTF, OTF 또는 TTC 글꼴을 선택해 주세요.")
        }
        val root = File(prepare(context), "custom")
        val temp = File.createTempFile("font-", ".$extension", context.cacheDir)
        try {
            temp.writeBytes(bytes)
            Typeface.createFromFile(temp)
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val destination = File(root, "$digest.$extension")
            if (!destination.exists()) check(temp.renameTo(destination)) { "글꼴을 저장하지 못했습니다." }
        } finally { temp.delete() }
    }
}
