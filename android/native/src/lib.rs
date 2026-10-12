use rhwp::service::{DocumentService, OpenOptions, TextExportOptions};
use serde_json::{json, Value};

const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PAGES: u32 = 200;
const MAX_TEXT_CHARS: usize = 1_000_000;

fn read_document(bytes: &[u8]) -> Value {
    let service = DocumentService::new()
        .with_max_bytes(Some(MAX_FILE_BYTES))
        .with_title_scan(false);
    let opened = match service.open_bytes(bytes, &OpenOptions::new()) {
        Ok(document) => document,
        Err(error) => {
            let message = if error.needs_password() {
                "비밀번호가 필요한 문서입니다. 첫 버전에서는 암호 문서를 열 수 없습니다.".to_owned()
            } else {
                error.to_string()
            };
            return json!({"ok": false, "code": error.code(), "message": message});
        }
    };
    let total_pages = opened.page_count();
    let text = opened.export_text(
        &TextExportOptions::new()
            .with_pages((0..total_pages.min(MAX_PAGES)).collect())
            .with_max_chars(MAX_TEXT_CHARS),
    );
    let pages: Vec<Value> = text.pages.iter().map(|page| {
        let warning = match (&page.extract_error, page.truncated) {
            (Some(error), _) => Some(format!("이 쪽의 텍스트를 추출하지 못했습니다: {error}")),
            (None, true) => Some("글자 수 제한으로 이 쪽의 일부만 표시했습니다.".to_owned()),
            _ => None,
        };
        json!({"index": page.page, "text": page.text, "warning": warning.unwrap_or_default()})
    }).collect();
    json!({
        "ok": true,
        "format": rhwp::service::format_token(opened.format()),
        "totalPages": total_pages,
        "pages": pages,
        "truncated": text.truncated || total_pages > MAX_PAGES,
    })
}

#[cfg(target_os = "android")]
mod android {
    use super::{read_document, MAX_FILE_BYTES};
    use jni::objects::{JByteArray, JObject};
    use jni::sys::jstring;
    use jni::JNIEnv;
    use serde_json::json;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    #[no_mangle]
    pub extern "system" fn Java_com_sihoo_hwp_NativeReader_readDocument(
        mut env: JNIEnv,
        _reader: JObject,
        data: JByteArray,
    ) -> jstring {
        // Keep Rust panics from unwinding across JNI.
        let result = catch_unwind(AssertUnwindSafe(|| {
            let length = env.get_array_length(&data).map_err(|e| e.to_string())?;
            if length as usize > MAX_FILE_BYTES {
                return Ok(json!({
                    "ok": false,
                    "code": "TOO_LARGE",
                    "message": "32 MB 이하의 문서를 선택해 주세요."
                }));
            }
            let bytes = env.convert_byte_array(&data).map_err(|e| e.to_string())?;
            Ok::<_, String>(read_document(&bytes))
        }));
        let reply = match result {
            Ok(Ok(value)) => value,
            Ok(Err(_)) => json!({
                "ok": false, "code": "JNI_ERROR", "message": "파일 데이터를 전달하지 못했습니다."
            }),
            Err(_) => json!({
                "ok": false, "code": "ENGINE_ERROR", "message": "문서 처리 중 오류가 발생했습니다."
            }),
        };
        match env.new_string(reply.to_string()) {
            Ok(value) => value.into_raw(),
            Err(_) => {
                let _ = env.throw_new("java/lang/IllegalStateException", "문서 결과를 전달하지 못했습니다.");
                std::ptr::null_mut()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_unsupported_and_oversized_inputs() {
        for input in [Vec::new(), b"not an hwp file".to_vec(), vec![0; MAX_FILE_BYTES + 1]] {
            let result = read_document(&input);
            assert_eq!(result["ok"], false);
            assert!(result["code"].as_str().is_some());
            assert!(result["message"].as_str().is_some_and(|s| !s.is_empty()));
        }
    }

    #[test]
    fn reads_real_document_fixtures_when_supplied() {
        let Some(dir) = std::env::var_os("HWP_FIXTURE_DIR") else {
            return;
        };
        for (name, format) in [("sample.hwp", "hwp5"), ("sample.hwpx", "hwpx"), ("sample3.hwp", "hwp3")] {
            let path = std::path::Path::new(&dir).join(name);
            let bytes = std::fs::read(path).expect("required fixture");
            let result = read_document(&bytes);
            assert_eq!(result["ok"], true, "{result}");
            assert_eq!(result["format"], format);
            assert!(result["totalPages"].as_u64().unwrap() > 0);
            assert!(result["pages"].as_array().unwrap().iter().any(|p| {
                p["text"].as_str().is_some_and(|s| !s.trim().is_empty())
            }), "fixture must contain readable text: {result}");
        }
    }
}
