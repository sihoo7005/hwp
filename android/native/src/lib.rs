mod canvas_svg;
use rhwp::renderer::pdf::PdfExportOptions;
use rhwp::renderer::svg::FontEmbedMode;
use rhwp::renderer::render_tree::{RenderNode, RenderNodeType};
use rhwp::service::{DocumentService, OpenOptions};
use rhwp::DocumentCore;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};

const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_EDITABLE_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_EDITABLE_PARAGRAPHS: usize = 5_000;
const MAX_EDITABLE_TEXT: usize = 200_000;
const MAX_EDITABLE_PARAGRAPH: usize = 20_000;
const MAX_HISTORY: usize = 20;
const CACHE_PAGES: usize = 12;
static NEXT_ID: AtomicI64 = AtomicI64::new(1);
static SESSIONS: OnceLock<Mutex<HashMap<i64, Session>>> = OnceLock::new();

struct Session {
    core: DocumentCore,
    format: String,
    can_edit: bool,
    edit_reason: String,
    dir: PathBuf,
    options: PdfExportOptions,
    cache: VecDeque<(u32, Value)>,
    fonts: Option<std::sync::Arc<usvg::fontdb::Database>>,
    undo: Vec<u32>,
    redo: Vec<u32>,
    dirty: bool,
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
    let (can_edit, edit_reason) = if bytes.len() > MAX_EDITABLE_FILE_BYTES {
        (false, "텍스트 편집은 8 MiB 이하의 문서에서 지원합니다.")
    } else { match format {
        "hwpx" => (true, ""),
        "hwp5" if supported_hwp_header(bytes) => (true, ""),
        "hwp5" => (false, "암호·배포용·서명·변경 추적 HWP는 읽기 전용입니다."),
        _ => (false, "HWP 5.x 또는 HWPX 문서만 편집할 수 있습니다."),
    }};
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
        // Reuse upstream SVG font configuration only; no PDF is generated.
        // Source text remains available separately for copying and accessibility.
        embed_text: false,
    };
    let session = Session { core: opened.into_core(), format: format.to_owned(), can_edit,
        edit_reason: edit_reason.to_owned(), dir, options,
        cache: VecDeque::new(), fonts: None, undo: Vec::new(), redo: Vec::new(), dirty: false };
    let editing = editor_state(&session);
    match sessions().lock() {
        Ok(mut sessions) => { sessions.insert(id, session); }
        Err(_) => return failure("ENGINE_ERROR", "문서 엔진 상태를 복구하지 못했습니다."),
    }
    json!({"ok": true, "id": id, "format": format, "totalPages": page_count,
        "warnings": warnings, "editing": editing})
}
fn supported_hwp_header(bytes: &[u8]) -> bool {
    let Ok(mut container) = cfb::CompoundFile::open(std::io::Cursor::new(bytes)) else { return false; };
    let Ok(mut stream) = container.open_stream("/FileHeader") else { return false; };
    let mut header = Vec::new();
    if stream.read_to_end(&mut header).is_err() || header.len() < 256 { return false; }
    header[35] == 5 && header[34] <= 1
        && u32::from_le_bytes([header[36], header[37], header[38], header[39]]) & !1 == 0
}
fn editable_paragraphs(session: &Session) -> Value {
    let allowed_format = session.can_edit;
    if !allowed_format {
        return json!({"canEdit": false, "reason": session.edit_reason, "paragraphs": [], "objects": []});
    }
    let controls: Vec<Value> = serde_json::from_str(&session.core.controls_json()).unwrap_or_default();
    let info: Value = serde_json::from_str(&session.core.get_document_info()).unwrap_or_default();
    let sections = info["sections"].as_u64().unwrap_or(0) as usize;
    let mut paragraphs = Vec::new();
    let mut global_para = 0usize;
    let mut total_chars = 0usize;
    let mut limit_exceeded = false;
    'sections: for section in 0..sections {
        let count = match session.core.get_paragraph_count_native(section) {
            Ok(count) => count,
            Err(_) => continue,
        };
        for paragraph in 0..count {
            if paragraphs.len() >= MAX_EDITABLE_PARAGRAPHS {
                limit_exceeded = true;
                break 'sections;
            }
            let text = session.core.get_text_range_native(section, paragraph, 0, usize::MAX)
                .unwrap_or_default();
            total_chars += text.chars().count();
            if total_chars > MAX_EDITABLE_TEXT {
                limit_exceeded = true;
                break 'sections;
            }
            let has_object = controls.iter().any(|control| {
                control["list"].as_u64() == Some(0)
                    && control["para"].as_u64() == Some(global_para as u64)
                    && !matches!(control["ctrlId"].as_str(), Some("secd" | "cold"))
            });
            paragraphs.push(json!({
                "section": section,
                "paragraph": paragraph,
                "text": text,
                "editable": allowed_format && !limit_exceeded && !has_object
                    && text.chars().count() <= MAX_EDITABLE_PARAGRAPH
            }));
            global_para += 1;
        }
    }
    let can_edit = allowed_format && !limit_exceeded;
    let reason = if limit_exceeded {
        "편집 범위는 5천 문단·20만 글자까지입니다."
    } else {
        ""
    };
    let mut objects = Vec::new();
    let mut section_counts = Vec::new();
    if let Ok(info) = serde_json::from_str::<Value>(&session.core.get_document_info()) {
        let sections = info["sections"].as_u64().unwrap_or(0) as usize;
        for section in 0..sections {
            section_counts.push(session.core.get_paragraph_count_native(section).unwrap_or(0));
        }
        if let Ok(raw) = serde_json::from_str::<Vec<Value>>(&session.core.objects_json()) {
            for item in raw {
                let Some(mut global) = item["para"].as_u64().map(|v| v as usize) else { continue };
                for (section, count) in section_counts.iter().enumerate() {
                    if global < *count {
                        objects.push(json!({"section": section, "paragraph": global,
                            "controlIndex": item["controlIndex"], "kind": item["kind"]}));
                        break;
                    }
                    global -= *count;
                }
            }
        }
    }
    json!({"canEdit": can_edit, "reason": reason,
        "paragraphs": if limit_exceeded { Vec::<Value>::new() } else { paragraphs }, "objects": objects})
}
fn editor_state(session: &Session) -> Value {
    let mut state = editable_paragraphs(session);
    if let Some(object) = state.as_object_mut() {
        object.insert("dirty".into(), json!(session.dirty));
        object.insert("canUndo".into(), json!(!session.undo.is_empty()));
        object.insert("canRedo".into(), json!(!session.redo.is_empty()));
        object.insert("totalPages".into(), json!(session.core.page_count()));
    }
    state
}
fn invalidate_pages(session: &mut Session) {
    session.cache.clear();
    let _ = std::fs::remove_dir_all(&session.dir);
    let _ = std::fs::create_dir_all(&session.dir);
}
fn edit_paragraph(id: i64, section: u32, paragraph: u32, before: &str, after: &str) -> Value {
    if after.chars().count() > MAX_EDITABLE_PARAGRAPH
        || after.chars().any(|ch| matches!(ch as u32, 0..=8 | 11..=31 | 127))
    {
        return failure("INVALID_TEXT", "문단은 2만 글자 이하의 일반 텍스트로 입력해 주세요.");
    }
    let mut sessions = match sessions().lock() {
        Ok(sessions) => sessions,
        Err(_) => return failure("ENGINE_ERROR", "문서 엔진 상태를 복구하지 못했습니다."),
    };
    let Some(session) = sessions.get_mut(&id) else {
        return failure("CLOSED_DOCUMENT", "문서가 닫혔습니다. 다시 열어 주세요.");
    };
    if !session.can_edit {
        return failure("READ_ONLY", "이 형식은 읽기 전용입니다.");
    }
    let state = editable_paragraphs(session);
    let target = state["paragraphs"].as_array().and_then(|paragraphs| paragraphs.iter().find(|item|
        item["section"].as_u64() == Some(section as u64)
            && item["paragraph"].as_u64() == Some(paragraph as u64)));
    if target.and_then(|item| item["editable"].as_bool()) != Some(true) {
        return failure("READ_ONLY", "이 문단은 편집할 수 없습니다.");
    }
    let current = match session.core.get_text_range_native(section as usize, paragraph as usize, 0, usize::MAX) {
        Ok(text) => text,
        Err(error) => return failure("EDIT_ERROR", error),
    };
    if current != before { return failure("STALE_TEXT", "문단이 변경되었습니다. 다시 열어 주세요."); }
    let total_chars: usize = state["paragraphs"].as_array().into_iter().flatten()
        .filter_map(|item| item["text"].as_str()).map(|text| text.chars().count()).sum();
    if total_chars.saturating_sub(current.chars().count()).saturating_add(after.chars().count()) > MAX_EDITABLE_TEXT {
        return failure("TEXT_LIMIT", "본문은 20만 글자까지 편집할 수 있습니다.");
    }
    if current == after { return json!({"ok": true, "changed": false, "state": editor_state(session)}); }
    let old: Vec<char> = current.chars().collect();
    let new: Vec<char> = after.chars().collect();
    let mut start = 0;
    while start < old.len() && start < new.len() && old[start] == new[start] { start += 1; }
    let mut end = 0;
    while end < old.len() - start && end < new.len() - start && old[old.len() - end - 1] == new[new.len() - end - 1] { end += 1; }
    let replacement: String = new[start..new.len() - end].iter().collect();
    let removed = old.len() - start - end;
    let snapshot = session.core.save_snapshot_native();
    if let Err(error) = session.core.replace_text_native(section as usize, paragraph as usize, start, removed, &replacement) {
        let _ = session.core.restore_snapshot_native(snapshot);
        session.core.discard_snapshot_native(snapshot);
        return failure("EDIT_ERROR", error);
    }
    let actual = session.core.get_text_range_native(section as usize, paragraph as usize, 0, usize::MAX)
        .unwrap_or_default();
    if actual != after {
        let _ = session.core.restore_snapshot_native(snapshot);
        session.core.discard_snapshot_native(snapshot);
        return failure("EDIT_ERROR", "수정한 문단을 확인하지 못했습니다.");
    }
    for previous in session.redo.drain(..) { session.core.discard_snapshot_native(previous); }
    session.undo.push(snapshot);
    if session.undo.len() > MAX_HISTORY {
        let expired = session.undo.remove(0);
        session.core.discard_snapshot_native(expired);
    }
    session.dirty = true;
    invalidate_pages(session);
    json!({"ok": true, "changed": true, "state": editor_state(session)})
}
fn edit_text_run(id: i64, command: &str) -> Value {
    let args: Value = match serde_json::from_str(command) {
        Ok(value) => value, Err(error) => return failure("INVALID_TEXT", error),
    };
    let number = |key: &str| args[key].as_u64().map(|v| v as usize);
    let (Some(section), Some(paragraph), Some(start)) =
        (number("section"), number("paragraph"), number("start")) else {
        return failure("INVALID_TEXT", "본문 위치가 필요합니다.");
    };
    let before = args["before"].as_str().unwrap_or("");
    let after = args["after"].as_str().unwrap_or("");
    if before.is_empty() || before.chars().count() > MAX_EDITABLE_PARAGRAPH
        || after.chars().count() > MAX_EDITABLE_PARAGRAPH
        || after.chars().any(|ch| matches!(ch as u32, 0..=8 | 11..=31 | 127)) {
        return failure("INVALID_TEXT", "선택한 글 범위가 너무 크거나 입력할 수 없는 문자가 있습니다.");
    }
    let path: Vec<(usize, usize, usize)> = match args["cellPath"].as_array() {
        Some(items) => match items.iter().map(|item| {
            let values = item.as_array().ok_or_else(|| "표 셀 위치가 올바르지 않습니다.".to_owned())?;
            if values.len() != 3 { return Err("표 셀 위치가 올바르지 않습니다.".to_owned()); }
            let a = values[0].as_u64().ok_or_else(|| "표 셀 위치가 올바르지 않습니다.".to_owned())? as usize;
            let b = values[1].as_u64().ok_or_else(|| "표 셀 위치가 올바르지 않습니다.".to_owned())? as usize;
            let c = values[2].as_u64().ok_or_else(|| "표 셀 위치가 올바르지 않습니다.".to_owned())? as usize;
            Ok((a, b, c))
        }).collect::<Result<Vec<_>, String>>() {
            Ok(path) => path, Err(error) => return failure("INVALID_TEXT", error),
        },
        None => return failure("INVALID_TEXT", "표 셀 위치가 올바르지 않습니다."),
    };
    if path.len() > 8 { return failure("INVALID_TEXT", "중첩 표 깊이가 너무 큽니다."); }
    let mut sessions = match sessions().lock() {
        Ok(sessions) => sessions, Err(_) => return failure("ENGINE_ERROR", "문서 엔진 상태를 복구하지 못했습니다."),
    };
    let Some(session) = sessions.get_mut(&id) else {
        return failure("CLOSED_DOCUMENT", "문서가 닫혔습니다. 다시 열어 주세요.");
    };
    if !session.can_edit { return failure("READ_ONLY", session.edit_reason.clone()); }
    let old_len = before.chars().count();
    let current = if path.is_empty() {
        session.core.get_text_range_native(section, paragraph, start, start + old_len)
    } else {
        session.core.get_text_in_cell_by_path(section, paragraph, &path, start, old_len)
    };
    let current = match current { Ok(text) => text, Err(error) => return failure("EDIT_ERROR", error) };
    if current != before { return failure("STALE_TEXT", "쪽이 다시 배치되었습니다. 글자를 다시 선택해 주세요."); }
    if before == after { return json!({"ok": true, "changed": false, "state": editor_state(session)}); }
    let snapshot = session.core.save_snapshot_native();
    let result = if path.is_empty() {
        session.core.replace_text_native(section, paragraph, start, old_len, after)
    } else {
        let delete = session.core.delete_text_in_cell_by_path(section, paragraph, &path, start, old_len);
        delete.and_then(|_| if after.is_empty() { Ok("{}".to_owned()) }
            else { session.core.insert_text_in_cell_by_path(section, paragraph, &path, start, after) })
    };
    if let Err(error) = result {
        let _ = session.core.restore_snapshot_native(snapshot);
        session.core.discard_snapshot_native(snapshot);
        return failure("EDIT_ERROR", error);
    }
    for previous in session.redo.drain(..) { session.core.discard_snapshot_native(previous); }
    session.undo.push(snapshot);
    if session.undo.len() > MAX_HISTORY {
        let expired = session.undo.remove(0);
        session.core.discard_snapshot_native(expired);
    }
    session.dirty = true;
    invalidate_pages(session);
    json!({"ok": true, "state": editor_state(session)})
}
fn history(id: i64, redo: bool) -> Value {
    let mut sessions = match sessions().lock() {
        Ok(sessions) => sessions,
        Err(_) => return failure("ENGINE_ERROR", "문서 엔진 상태를 복구하지 못했습니다."),
    };
    let Some(session) = sessions.get_mut(&id) else {
        return failure("CLOSED_DOCUMENT", "문서가 닫혔습니다. 다시 열어 주세요.");
    };
    let snapshot = if redo { session.redo.pop() } else { session.undo.pop() };
    let Some(snapshot) = snapshot else {
        return json!({"ok": true, "changed": false, "state": editor_state(session)});
    };
    let current = session.core.save_snapshot_native();
    if let Err(error) = session.core.restore_snapshot_native(snapshot) {
        session.core.discard_snapshot_native(current);
        if redo { session.redo.push(snapshot); } else { session.undo.push(snapshot); }
        return failure("HISTORY_ERROR", error);
    }
    session.core.discard_snapshot_native(snapshot);
    if redo { session.undo.push(current); } else { session.redo.push(current); }
    session.dirty = true;
    invalidate_pages(session);
    json!({"ok": true, "changed": true, "state": editor_state(session)})
}
fn mutate_document(id: i64, command: &str) -> Value {
    let mut sessions = match sessions().lock() {
        Ok(sessions) => sessions,
        Err(_) => return failure("ENGINE_ERROR", "문서 엔진 상태를 복구하지 못했습니다."),
    };
    let Some(session) = sessions.get_mut(&id) else {
        return failure("CLOSED_DOCUMENT", "문서가 닫혔습니다. 다시 열어 주세요.");
    };
    if !session.can_edit { return failure("READ_ONLY", session.edit_reason.clone()); }
    let args: Value = match serde_json::from_str(command) {
        Ok(value) => value,
        Err(error) => return failure("INVALID_COMMAND", error),
    };
    let number = |key: &str| args[key].as_u64().map(|v| v as usize);
    let (Some(section), Some(paragraph)) = (number("section"), number("paragraph")) else {
        return failure("INVALID_COMMAND", "문단 위치가 필요합니다.");
    };
    let operation = args["operation"].as_str().unwrap_or("");
    let props = args["properties"].to_string();
    let path: Vec<(usize, usize, usize)> = args["properties"]["cellPath"].as_array()
        .map(|items| items.iter().filter_map(|item| Some((
            item.get(0)?.as_u64()? as usize,
            item.get(1)?.as_u64()? as usize,
            item.get(2)?.as_u64()? as usize,
        ))).collect()).unwrap_or_default();
    let snapshot = session.core.save_snapshot_native();
    let result = match operation {
        "characterFormat" => {
            let start = args["properties"]["start"].as_u64().unwrap_or(0) as usize;
            let end = args["properties"]["end"].as_u64().unwrap_or_else(||
                session.core.get_paragraph_length_native(section, paragraph).unwrap_or(0) as u64) as usize;
            if path.is_empty() {
                session.core.apply_char_format_native(section, paragraph, start, end, &props).map(|_| ())
            } else {
                session.core.apply_char_format_in_cell_by_path(section, paragraph, &path, start, end, &props).map(|_| ())
            }
        }
        "paragraphFormat" => if path.len() == 1 {
            let (control, cell, cell_para) = path[0];
            session.core.apply_para_format_in_cell_native(section, paragraph, control, cell, cell_para, &props).map(|_| ())
        } else if path.len() > 1 {
            return failure("EDIT_ERROR", "중첩 표 문단 정렬은 아직 지원하지 않습니다.");
        } else { session.core.apply_para_format_native(section, paragraph, &props).map(|_| ()) },
        "insertTable" => {
            let rows = args["rows"].as_u64().unwrap_or(2).clamp(1, 50) as u16;
            let columns = args["columns"].as_u64().unwrap_or(2).clamp(1, 20) as u16;
            let offset = args["properties"]["offset"].as_u64().map(|v| v as usize)
                .unwrap_or_else(|| session.core.get_paragraph_length_native(section, paragraph).unwrap_or(0));
            session.core.create_table_native(section, paragraph, offset, rows, columns).map(|_| ())
        }
        "insertEquation" => {
            let offset = args["properties"]["offset"].as_u64().map(|v| v as usize)
                .unwrap_or_else(|| session.core.get_paragraph_length_native(section, paragraph).unwrap_or(0));
            let script = args["script"].as_str().unwrap_or("x = y");
            session.core.insert_equation_native(section, paragraph, offset, script, 1000, 0).map(|_| ())
        }
        "insertShape" => {
            let offset = args["properties"]["offset"].as_u64().map(|v| v as usize)
                .unwrap_or_else(|| session.core.get_paragraph_length_native(section, paragraph).unwrap_or(0));
            session.core.create_shape_control_native(section, paragraph, offset, 18_000, 10_000,
                0, 0, true, "TopAndBottom", "rectangle", false, false, &[]).map(|_| ())
        }
        "deleteObject" => {
            let Some(control) = number("controlIndex") else {
                return failure("INVALID_COMMAND", "개체 위치가 필요합니다.");
            };
            session.core.delete_control_native(section, paragraph, control).map(|_| ())
        }
        _ => return failure("INVALID_COMMAND", "지원하지 않는 편집 작업입니다."),
    };
    if let Err(error) = result {
        let _ = session.core.restore_snapshot_native(snapshot);
        session.core.discard_snapshot_native(snapshot);
        return failure("EDIT_ERROR", error);
    }
    for previous in session.redo.drain(..) { session.core.discard_snapshot_native(previous); }
    session.undo.push(snapshot);
    if session.undo.len() > MAX_HISTORY {
        let expired = session.undo.remove(0);
        session.core.discard_snapshot_native(expired);
    }
    session.dirty = true;
    invalidate_pages(session);
    json!({"ok": true, "state": editor_state(session)})
}
fn insert_picture(id: i64, section: usize, paragraph: usize, offset: usize, data: &[u8], extension: &str,
    width: u32, height: u32) -> Value {
    if data.is_empty() || data.len() > 8 * 1024 * 1024 {
        return failure("INVALID_IMAGE", "그림 파일은 8 MiB 이하로 선택해 주세요.");
    }
    let extension = extension.to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "bmp" | "gif") {
        return failure("INVALID_IMAGE", "PNG, JPEG, BMP, GIF 그림만 삽입할 수 있습니다.");
    }
    let mut sessions = match sessions().lock() {
        Ok(sessions) => sessions,
        Err(_) => return failure("ENGINE_ERROR", "문서 엔진 상태를 복구하지 못했습니다."),
    };
    let Some(session) = sessions.get_mut(&id) else {
        return failure("CLOSED_DOCUMENT", "문서가 닫혔습니다. 다시 열어 주세요.");
    };
    if !session.can_edit { return failure("READ_ONLY", session.edit_reason.clone()); }
    let length = match session.core.get_paragraph_length_native(section, paragraph) {
        Ok(length) => length, Err(error) => return failure("EDIT_ERROR", error),
    };
    if offset > length { return failure("EDIT_ERROR", "그림을 넣을 글 위치가 변경되었습니다."); }
    let natural_width = width.max(1);
    let natural_height = height.max(1);
    let scale = (30_000.0 / (natural_width.max(natural_height) as f64 * 75.0)).min(1.0);
    let scaled_width = (natural_width as f64 * scale * 75.0).round().max(1.0) as u32;
    let scaled_height = (natural_height as f64 * scale * 75.0).round().max(1.0) as u32;
    let snapshot = session.core.save_snapshot_native();
    if let Err(error) = session.core.insert_picture_native(section, paragraph, offset, &[], data,
        scaled_width, scaled_height, natural_width, natural_height,
        if extension == "jpeg" { "jpg" } else { extension.as_str() }, "", None, None) {
        let _ = session.core.restore_snapshot_native(snapshot);
        session.core.discard_snapshot_native(snapshot);
        return failure("EDIT_ERROR", error);
    }
    for previous in session.redo.drain(..) { session.core.discard_snapshot_native(previous); }
    session.undo.push(snapshot);
    if session.undo.len() > MAX_HISTORY {
        let expired = session.undo.remove(0);
        session.core.discard_snapshot_native(expired);
    }
    session.dirty = true;
    invalidate_pages(session);
    json!({"ok": true, "state": editor_state(session)})
}
fn body_texts(core: &DocumentCore) -> Result<Vec<String>, String> {
    let info: Value = serde_json::from_str(&core.get_document_info()).map_err(|e| e.to_string())?;
    let sections = info["sections"].as_u64().unwrap_or(0) as usize;
    let mut texts = Vec::new();
    for section in 0..sections {
        let count = core.get_paragraph_count_native(section).map_err(|e| e.to_string())?;
        for paragraph in 0..count {
            texts.push(core.get_text_range_native(section, paragraph, 0, usize::MAX).map_err(|e| e.to_string())?);
        }
    }
    Ok(texts)
}
fn export_document(id: i64) -> Result<Vec<u8>, String> {
    let mut sessions = sessions().lock().map_err(|_| "문서 엔진 상태를 복구하지 못했습니다.".to_owned())?;
    let session = sessions.get_mut(&id).ok_or_else(|| "문서가 닫혔습니다. 다시 열어 주세요.".to_owned())?;
    if editable_paragraphs(session)["canEdit"].as_bool() != Some(true) {
        return Err("이 형식은 읽기 전용입니다.".into());
    }
    let (bytes, report) = if session.format == "hwpx" {
        session.core.export_hwpx_native_with_report().map_err(|e| e.to_string())?.into_parts()
    } else {
        session.core.export_hwp_with_adapter_snapshot_with_report().map_err(|e| e.to_string())?.into_parts()
    };
    if !report.is_empty() {
        return Err(format!("저장 중 문서 내용 손실 가능성이 {}건 발견되어 저장을 중단했습니다.", report.len()));
    }
    let reopened = DocumentCore::from_bytes(&bytes).map_err(|e| format!("저장 결과를 다시 열지 못했습니다: {e}"))?;
    if body_texts(&session.core)? != body_texts(&reopened)? {
        return Err("저장 결과의 본문이 수정 전 문서와 달라 저장을 중단했습니다.".into());
    }
    Ok(bytes)
}
fn mark_saved(id: i64) -> Result<(), String> {
    let mut sessions = sessions().lock().map_err(|_| "문서 엔진 상태를 복구하지 못했습니다.".to_owned())?;
    let session = sessions.get_mut(&id).ok_or_else(|| "문서가 닫혔습니다. 다시 열어 주세요.".to_owned())?;
    session.dirty = false;
    Ok(())
}
fn placeholders(node: &RenderNode) -> usize {
    usize::from(node.visible && matches!(node.node_type, RenderNodeType::Placeholder(_)))
        + node.children.iter().map(placeholders).sum::<usize>()
}
fn collect_text_runs(node: &RenderNode, output: &mut Vec<Value>) {
    if let RenderNodeType::TextRun(run) = &node.node_type {
        if node.visible && run.display_text.is_none() && !run.text.is_empty()
            && !run.text.chars().any(|ch| ch < ' ' || ch == '\u{7f}')
        {
            if let (Some(section), Some(paragraph), Some(start)) =
                (run.section_index, run.para_index, run.char_start)
            {
                let cell_path = run.cell_context.as_ref().filter(|context| !context.in_textbox)
                    .map(|context| context.path.iter().map(|entry| json!([
                        entry.control_index, entry.cell_index, entry.cell_para_index
                    ])).collect::<Vec<_>>()).unwrap_or_default();
                if run.cell_context.as_ref().is_none_or(|context| !context.in_textbox) {
                    let target_paragraph = run.cell_context.as_ref()
                        .map(|context| context.parent_para_index).unwrap_or(paragraph);
                    output.push(json!({"section": section, "paragraph": target_paragraph, "start": start,
                        "text": run.text, "x": node.bbox.x, "y": node.bbox.y,
                        "width": node.bbox.width, "height": node.bbox.height, "cellPath": cell_path}));
                }
            }
        }
    }
    for child in &node.children { collect_text_runs(child, output); }
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
    let source = match session.core.render_page_svg_with_fonts(index, FontEmbedMode::None,
        &session.options.font_paths) {
        Ok(svg) => svg, Err(error) => return failure("RENDER_ERROR", error),
    };
    let fonts = session.fonts.get_or_insert_with(|| canvas_svg::font_database(&session.options)).clone();
    let (svg, mut warnings) = match canvas_svg::outline(&source, &session.options, fonts) {
        Ok(rendered) => rendered, Err(error) => return failure("RENDER_ERROR", error),
    };
    let path = session.dir.join(format!("{index}.svg"));
    if let Err(error) = std::fs::write(&path, svg) { return failure("CACHE_ERROR", error); }
    // Keep source object bounds alongside the display. Editing continues to target
    // the live DocumentCore, never the outlined SVG or a flattened PDF.
    let layout_path = session.dir.join(format!("{index}.json"));
    if let Err(error) = std::fs::write(&layout_path, tree.root.to_json()) {
        return failure("CACHE_ERROR", error);
    }
    let mut text_runs = Vec::new();
    collect_text_runs(&tree.root, &mut text_runs);
    let text_runs_path = session.dir.join(format!("{index}-text.json"));
    if let Err(error) = std::fs::write(&text_runs_path, serde_json::to_vec(&text_runs).unwrap_or_default()) {
        return failure("CACHE_ERROR", error);
    }
    if unresolved > 0 {
        warnings.push(format!("이 쪽에 표시 엔진이 해석하지 못한 개체 {unresolved}개가 있습니다."));
    }
    let text = match session.core.extract_page_text_native(index) {
        Ok(text) => text,
        Err(error) => { warnings.push(format!("본문 텍스트 추출 실패: {error}")); String::new() }
    };
    let reply = json!({"ok": true, "index": index, "svgPath": path.to_string_lossy(), "layoutPath": layout_path.to_string_lossy(),
        "textRunsPath": text_runs_path.to_string_lossy(),
        "text": text, "warnings": warnings, "unresolvedObjects": unresolved});
    session.cache.push_back((index, reply.clone()));
    while session.cache.len() > CACHE_PAGES {
        if let Some((old, _)) = session.cache.pop_front() {
            let _ = std::fs::remove_file(session.dir.join(format!("{old}.svg")));
            let _ = std::fs::remove_file(session.dir.join(format!("{old}.json")));
            let _ = std::fs::remove_file(session.dir.join(format!("{old}-text.json")));
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
    use jni::sys::{jboolean, jbyteArray, jint, jlong, jstring};
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
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_editParagraph(
        mut env: JNIEnv, _reader: JObject, id: jlong, section: jint, paragraph: jint,
        before: JString, after: JString,
    ) -> jstring {
        let value = catch_unwind(AssertUnwindSafe(|| {
            if section < 0 || paragraph < 0 { return failure("EDIT_ERROR", "잘못된 문단 위치입니다."); }
            let before: String = match env.get_string(&before) { Ok(value) => value.into(), Err(error) => return failure("JNI_ERROR", error) };
            let after: String = match env.get_string(&after) { Ok(value) => value.into(), Err(error) => return failure("JNI_ERROR", error) };
            edit_paragraph(id, section as u32, paragraph as u32, &before, &after)
        })).unwrap_or_else(|_| failure("ENGINE_ERROR", "문단을 수정하는 중 오류가 발생했습니다."));
        reply(env, value)
    }
    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_historyNative(
        env: JNIEnv, _reader: JObject, id: jlong, redo: jboolean,
    ) -> jstring {
        let value = catch_unwind(AssertUnwindSafe(|| history(id, redo != 0)))
            .unwrap_or_else(|_| failure("ENGINE_ERROR", "문서 이력을 복원하는 중 오류가 발생했습니다."));
        reply(env, value)
    }
    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_mutateNative(
        mut env: JNIEnv, _reader: JObject, id: jlong, command: JString,
    ) -> jstring {
        let value = catch_unwind(AssertUnwindSafe(|| {
            let command: String = match env.get_string(&command) {
                Ok(value) => value.into(), Err(error) => return failure("JNI_ERROR", error),
            };
            mutate_document(id, &command)
        })).unwrap_or_else(|_| failure("ENGINE_ERROR", "문서를 편집하는 중 오류가 발생했습니다."));
        reply(env, value)
    }
    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_editTextRunNative(
        mut env: JNIEnv, _reader: JObject, id: jlong, command: JString,
    ) -> jstring {
        let value = catch_unwind(AssertUnwindSafe(|| {
            let command: String = match env.get_string(&command) {
                Ok(value) => value.into(), Err(error) => return failure("JNI_ERROR", error),
            };
            edit_text_run(id, &command)
        })).unwrap_or_else(|_| failure("ENGINE_ERROR", "쪽의 글을 수정하는 중 오류가 발생했습니다."));
        reply(env, value)
    }
    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_insertPictureNative(
        mut env: JNIEnv, _reader: JObject, id: jlong, section: jint, paragraph: jint, offset: jint,
        data: JByteArray, extension: JString, width: jint, height: jint,
    ) -> jstring {
        let value = catch_unwind(AssertUnwindSafe(|| {
            if section < 0 || paragraph < 0 || offset < 0 || width <= 0 || height <= 0 {
                return failure("INVALID_IMAGE", "그림 정보가 올바르지 않습니다.");
            }
            let bytes = match env.convert_byte_array(&data) {
                Ok(bytes) => bytes, Err(error) => return failure("JNI_ERROR", error),
            };
            let extension: String = match env.get_string(&extension) {
                Ok(value) => value.into(), Err(error) => return failure("JNI_ERROR", error),
            };
            insert_picture(id, section as usize, paragraph as usize, offset as usize, &bytes, &extension,
                width as u32, height as u32)
        })).unwrap_or_else(|_| failure("ENGINE_ERROR", "그림을 삽입하는 중 오류가 발생했습니다."));
        reply(env, value)
    }
    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_exportDocument(
        mut env: JNIEnv, _reader: JObject, id: jlong,
    ) -> jbyteArray {
        let bytes = match catch_unwind(AssertUnwindSafe(|| export_document(id))) {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => {
                let _ = env.throw_new("java/lang/IllegalStateException", error);
                return std::ptr::null_mut();
            }
            Err(_) => {
                let _ = env.throw_new("java/lang/IllegalStateException", "문서를 저장하는 중 오류가 발생했습니다.");
                return std::ptr::null_mut();
            }
        };
        match env.byte_array_from_slice(&bytes) {
            Ok(array) => array.into_raw(),
            Err(error) => {
                let _ = env.throw_new("java/lang/IllegalStateException", error.to_string());
                std::ptr::null_mut()
            }
        }
    }
    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_markSaved(
        mut env: JNIEnv, _reader: JObject, id: jlong,
    ) {
        if let Err(error) = mark_saved(id) {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
        }
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
            ("shapes.hwp", "hwp5"), ("chart.hwp", "hwp5"), ("chart.hwpx", "hwpx"),
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
                let svg = std::fs::read_to_string(page["svgPath"].as_str().unwrap()).unwrap();
                assert!(svg.contains("<svg"), "{name}");
                assert!(!svg.contains("<text"), "all glyphs must be outlined: {name}");
                std::fs::write(artifacts.join(format!("{name}-{index}.svg")), svg).unwrap();
                std::fs::copy(page["layoutPath"].as_str().unwrap(),
                    artifacts.join(format!("{name}-{index}.json"))).unwrap();
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
