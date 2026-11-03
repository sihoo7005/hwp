package com.sihoo.hwp;

import java.nio.file.*;
import java.util.regex.*;

/** Runs the Android JNI engine on an ARM64 Android JVM, without installing the app. */
public final class NativeReader {
    static { System.loadLibrary("hwp_reader"); }
    private static native String openDocument(byte[] bytes, String fonts, String cache);
    private static native String createDocument(String fonts, String cache);
    private static native String renderPage(long id, int index);
    private static native String editParagraph(long id, int section, int paragraph, String before, String after);
    private static native String mutateNative(long id, String command);
    private static native String editTextRunNative(long id, String command);
    private static native String historyNative(long id, boolean redo);
    private static native byte[] exportDocumentAs(long id, String format);
    private static native void markSaved(long id);
    private static native void closeDocument(long id);

    static String ok(String json) {
        if (!json.contains("\"ok\":true")) throw new AssertionError(json);
        return json;
    }
    static long id(String json) {
        Matcher m = Pattern.compile("\"id\":([0-9]+)").matcher(ok(json));
        if (!m.find()) throw new AssertionError(json);
        return Long.parseLong(m.group(1));
    }
    public static void main(String[] args) throws Exception {
        String fonts = args[0], cache = args[1], fixtures = args[2], output = args[3];
        Files.createDirectories(Path.of(cache));
        Files.createDirectories(Path.of(output));
        for (String file : new String[]{"hwp3-tab.hwp", "hwp5-korean.hwp", "hwpx-table.hwpx"}) {
            long handle = id(openDocument(Files.readAllBytes(Path.of(fixtures, file)), fonts, cache));
            try { ok(renderPage(handle, 0)); }
            finally { closeDocument(handle); }
            System.out.println("PASS JNI open/render: " + file);
        }
        long handle = id(createDocument(fonts, cache));
        final String text = "안드로이드 네이티브 한글 편집 🙂";
        try {
            ok(editParagraph(handle, 0, 0, "", text));
            ok(mutateNative(handle, "{\"operation\":\"characterFormat\",\"section\":0,\"paragraph\":0,\"properties\":{\"bold\":true,\"fontSize\":1400}}"));
            ok(renderPage(handle, 0));
            ok(historyNative(handle, false));
            ok(historyNative(handle, true));
            for (String format : new String[]{"hwp", "hwpx"}) {
                byte[] bytes = exportDocumentAs(handle, format);
                if (bytes.length == 0) throw new AssertionError("Empty export");
                Path path = Path.of(output, "jni-edited." + format);
                Files.write(path, bytes);
                String opened = openDocument(bytes, fonts, cache);
                long reopened = id(opened);
                try {
                    if (!opened.contains(text)) throw new AssertionError("Text lost: " + opened);
                    ok(renderPage(reopened, 0));
                } finally { closeDocument(reopened); }
                System.out.println("PASS JNI create/edit/format/undo/redo/export/reopen: " + format);
            }
            markSaved(handle);
        } finally { closeDocument(handle); }
        long tableHandle = id(openDocument(Files.readAllBytes(Path.of(fixtures, "hwpx-table.hwpx")), fonts, cache));
        try {
            ok(editTextRunNative(tableHandle, "{\"section\":0,\"paragraph\":0,\"start\":1,\"before\":\"-0\",\"after\":\"-모바일0\",\"cellPath\":[[2,0,0]]}"));
            ok(mutateNative(tableHandle, "{\"operation\":\"paragraphFormat\",\"section\":0,\"paragraph\":0,\"properties\":{\"alignment\":\"center\",\"cellPath\":[[2,0,0]]}}"));
            for (String operation : new String[]{"insertRowBelow", "insertColumnRight"}) {
                ok(mutateNative(tableHandle, "{\"operation\":\"" + operation + "\",\"section\":0,\"paragraph\":0,\"properties\":{\"cellPath\":[[2,0,0]]}}"));
            }
            for (String format : new String[]{"hwp", "hwpx"}) {
                byte[] bytes = exportDocumentAs(tableHandle, format);
                String opened = openDocument(bytes, fonts, cache);
                long reopened = id(opened);
                try { ok(renderPage(reopened, 0)); }
                finally { closeDocument(reopened); }
                Files.write(Path.of(output, "jni-table-edited." + format), bytes);
                System.out.println("PASS JNI nonzero-offset cell edit/paragraph format/table row+column/export: " + format);
            }
        } finally { closeDocument(tableHandle); }
        if (renderPage(handle, 0).contains("\"ok\":true")) throw new AssertionError("Closed handle accepted");
        System.out.println("PASS JNI closed-session rejection");
    }
}
