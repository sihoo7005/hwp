use rhwp::renderer::pdf::PdfExportOptions;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::service::{DocumentService, OpenOptions};
use rhwp::DocumentCore;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};

const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_PAGES: usize = 12;
static NEXT_ID: AtomicI64 = AtomicI64::new(1);
static SESSIONS: OnceLock<Mutex<HashMap<i64, Session>>> = OnceLock::new();

struct Session {
    core: DocumentCore,
    dir: PathBuf,
    options: PdfExportOptions,
    cache: VecDeque<(u32, Value)>,
}
impl Drop for Session {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); }
}
fn sessions() -> &'static Mutex<HashMap<i64, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn failure(code: &str, message: impl ToString) -> Value {
    json!({"ok": false, "code": code, "message": message.to_string()})
}
fn open_document(bytes: &[u8], font_root: &Path, cache_root: &Path) -> Value {
    let opened = match DocumentService::new().with_max_bytes(Some(MAX_FILE_BYTES))
        .with_title_scan(false).open_bytes(bytes, &OpenOptions::new()) {
        Ok(opened) => opened,
        Err(error) => return failure(error.code(), if error.needs_password() {
            "비밀번호가 필요한 문서입니다. 암호 문서 열기는 아직 지원하지 않습니다.".to_owned()
        } else { error.to_string() }),
    };
    let page_count = opened.page_count();
    if page_count == 0 { return failure("EMPTY_DOCUMENT", "표시할 페이지가 없습니다."); }
    let format = rhwp::service::format_token(opened.format());
    let warnings: Vec<String> = opened.core().validation_report().warnings.iter().map(|w| {
        format!("구역 {} · 문단 {}: {}", w.section_idx + 1, w.paragraph_idx + 1, w.kind)
    }).collect();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_nanos();
    let dir = cache_root.join(format!("reader-{id}-{timestamp}"));
    if let Err(error) = std::fs::create_dir_all(&dir) { return failure("CACHE_ERROR", error); }
    let mut font_paths = vec![font_root.join("custom"), font_root.join("bundled")];
    if Path::new("/system/fonts").exists() { font_paths.push(PathBuf::from("/system/fonts")); }
    let options = PdfExportOptions {
        fallback_serif: "Noto Serif KR".into(), fallback_sans: "Noto Sans KR".into(),
        fallback_mono: "D2Coding".into(), equation_font: Some("Latin Modern Math".into()),
        font_paths,
        // Glyph paths avoid font-subsetting failures and reduce mobile peak memory.
        // Source text remains available separately for copying and accessibility.
        embed_text: false,
    };
    let session = Session { core: opened.into_core(), dir, options, cache: VecDeque::new() };
    match sessions().lock() {
        Ok(mut sessions) => { sessions.insert(id, session); }
        Err(_) => return failure("ENGINE_ERROR", "문서 엔진 상태를 복구하지 못했습니다."),
    }
    json!({"ok": true, "id": id, "format": format, "totalPages": page_count, "warnings": warnings})
}
fn placeholders(node: &RenderNode) -> usize {
    usize::from(node.visible && matches!(node.node_type, RenderNodeType::Placeholder(_)))
        + node.children.iter().map(placeholders).sum::<usize>()
}
fn render_page(id: i64, index: u32) -> Value {
    let mut sessions = match sessions().lock() {
        Ok(sessions) => sessions,
        Err(_) => return failure("ENGINE_ERROR", "문서 엔진 상태를 복구하지 못했습니다."),
    };
    let Some(session) = sessions.get_mut(&id) else {
        return failure("CLOSED_DOCUMENT", "문서가 닫혔습니다. 다시 열어 주세요.");
    };
    if index >= session.core.page_count() { return failure("PAGE_RANGE", "문서의 페이지 범위를 벗어났습니다."); }
    if let Some((_, reply)) = session.cache.iter().find(|(page, _)| *page == index) {
        return reply.clone();
    }
    let tree = match session.core.build_page_render_tree(index) {
        Ok(tree) => tree, Err(error) => return failure("LAYOUT_ERROR", error),
    };
    let unresolved = placeholders(&tree.root);
    let pdf = match session.core.render_pages_pdf_native_with_options(&[index], &session.options) {
        Ok(pdf) => pdf, Err(error) => return failure("RENDER_ERROR", error),
    };
    let path = session.dir.join(format!("{index}.pdf"));
    if let Err(error) = std::fs::write(&path, pdf) { return failure("CACHE_ERROR", error); }
    let mut warnings = Vec::new();
    if unresolved > 0 {
        warnings.push(format!("이 쪽에 표시 엔진이 해석하지 못한 개체 {unresolved}개가 있습니다."));
    }
    let text = match session.core.extract_page_text_native(index) {
        Ok(text) => text,
        Err(error) => { warnings.push(format!("본문 텍스트 추출 실패: {error}")); String::new() }
    };
    let reply = json!({"ok": true, "index": index, "pdfPath": path.to_string_lossy(),
        "text": text, "warnings": warnings, "unresolvedObjects": unresolved});
    session.cache.push_back((index, reply.clone()));
    while session.cache.len() > CACHE_PAGES {
        if let Some((old, _)) = session.cache.pop_front() {
            let _ = std::fs::remove_file(session.dir.join(format!("{old}.pdf")));
        }
    }
    reply
}
fn close_document(id: i64) {
    if let Ok(mut sessions) = sessions().lock() { sessions.remove(&id); }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use jni::objects::{JByteArray, JObject, JString};
    use jni::sys::{jint, jlong, jstring};
    use jni::JNIEnv;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn reply(mut env: JNIEnv, value: Value) -> jstring {
        match env.new_string(value.to_string()) {
            Ok(value) => value.into_raw(),
            Err(_) => {
                let _ = env.throw_new("java/lang/IllegalStateException", "문서 결과를 전달하지 못했습니다.");
                std::ptr::null_mut()
            }
        }
    }
    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_openDocument(
        mut env: JNIEnv, _reader: JObject, data: JByteArray, fonts: JString, cache: JString,
    ) -> jstring {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let len = env.get_array_length(&data).map_err(|e| e.to_string())?;
            if len as usize > MAX_FILE_BYTES {
                return Ok(failure("TOO_LARGE", "32 MB 이하의 문서를 선택해 주세요."));
            }
            let data = env.convert_byte_array(&data).map_err(|e| e.to_string())?;
            let fonts: String = env.get_string(&fonts).map_err(|e| e.to_string())?.into();
            let cache: String = env.get_string(&cache).map_err(|e| e.to_string())?.into();
            Ok::<_, String>(open_document(&data, Path::new(&fonts), Path::new(&cache)))
        }));
        let value = match result {
            Ok(Ok(value)) => value, Ok(Err(error)) => failure("JNI_ERROR", error),
            Err(_) => failure("ENGINE_ERROR", "문서를 여는 중 오류가 발생했습니다."),
        };
        reply(env, value)
    }
    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_renderPage(
        env: JNIEnv, _reader: JObject, id: jlong, index: jint,
    ) -> jstring {
        let value = catch_unwind(AssertUnwindSafe(|| {
            if index < 0 { failure("PAGE_RANGE", "잘못된 페이지입니다.") }
            else { render_page(id, index as u32) }
        })).unwrap_or_else(|_| failure("ENGINE_ERROR", "페이지를 그리는 중 오류가 발생했습니다."));
        reply(env, value)
    }
    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_closeDocument(
        _env: JNIEnv, _reader: JObject, id: jlong,
    ) { let _ = catch_unwind(AssertUnwindSafe(|| close_document(id))); }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn equation_boxes(node: &RenderNode, boxes: &mut Vec<Value>) {
        if matches!(node.node_type, RenderNodeType::Equation(_)) {
            boxes.push(json!([node.bbox.x, node.bbox.y, node.bbox.width, node.bbox.height]));
        }
        for child in &node.children { equation_boxes(child, boxes); }
    }
    #[test]
    fn rejects_invalid_input_and_stale_sessions() {
        for input in [Vec::new(), b"not an hwp file".to_vec(), vec![0; MAX_FILE_BYTES + 1]] {
            assert_eq!(open_document(&input, Path::new("/tmp/fonts"), Path::new("/tmp/hwp-test"))["ok"], false);
        }
        assert_eq!(render_page(-1, 0)["ok"], false);
        close_document(-1);
    }
    #[test]
    fn renders_real_documents_and_preserves_page_identity() {
        let Some(dir) = std::env::var_os("HWP_FIXTURE_DIR") else { return };
        let font_root = std::env::var_os("HWP_FONT_ROOT").expect("fonts required for render checks");
        let dir = PathBuf::from(dir);
        let artifacts = dir.join("rendered");
        std::fs::create_dir_all(&artifacts).unwrap();
        for (name, format) in [
            ("sample.hwp", "hwp5"), ("sample.hwpx", "hwpx"), ("sample3.hwp", "hwp3"),
            ("equation.hwpx", "hwpx"), ("image.hwpx", "hwpx"), ("table.hwpx", "hwpx"),
        ] {
            let opened = open_document(&std::fs::read(dir.join(name)).expect("fixture"),
                Path::new(&font_root), &dir.join("cache"));
            assert_eq!(opened["ok"], true, "{opened}");
            assert_eq!(opened["format"], format);
            let id = opened["id"].as_i64().unwrap();
            let count = opened["totalPages"].as_u64().unwrap() as u32;
            for index in [0, count - 1] {
                let page = render_page(id, index);
                assert_eq!(page["ok"], true, "{page}");
                assert_eq!(page["index"], index);
                let pdf = std::fs::read(page["pdfPath"].as_str().unwrap()).unwrap();
                assert!(pdf.starts_with(b"%PDF-"), "{name}");
                std::fs::write(artifacts.join(format!("{name}-{index}.pdf")), pdf).unwrap();
                if name == "equation.hwpx" && index == 0 {
                    let sessions = sessions().lock().unwrap();
                    let tree = sessions[&id].core.build_page_render_tree(index).unwrap();
                    let mut boxes = Vec::new();
                    equation_boxes(&tree.root, &mut boxes);
                    assert!(!boxes.is_empty(), "equation fixture must contain equation nodes");
                    std::fs::write(artifacts.join("equation-boxes.json"), serde_json::to_vec(&boxes).unwrap()).unwrap();
                }
                assert_eq!(render_page(id, index), page, "cached page identity");
            }
            assert_eq!(render_page(id, count)["ok"], false);
            close_document(id);
            assert_eq!(render_page(id, 0)["ok"], false);
        }
    }
}
