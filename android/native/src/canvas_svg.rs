//! rhwp layer SVG -> portable, outlined SVG for Android's native Canvas.
//! PDF font helpers are reused only for font resolution and synthetic styles.
use rhwp::renderer::pdf::{apply_pdf_font_options, parse_svg_with_synthetic_italic,
    prepare_svg_with_synthetic_bold, PdfExportOptions};
use std::sync::Arc;
use std::cell::Cell;
thread_local! { static IMAGE_DEPTH: Cell<u8> = const { Cell::new(0) }; }
struct ImageDepthGuard;
impl Drop for ImageDepthGuard {
    fn drop(&mut self) { IMAGE_DEPTH.with(|depth| depth.set(depth.get() - 1)); }
}

pub fn font_database(fonts: &PdfExportOptions) -> Arc<usvg::fontdb::Database> {
    let mut database = usvg::fontdb::Database::new();
    rhwp::renderer::font_paths::load_into_fontdb(&mut database, &fonts.font_paths);
    database.set_serif_family(&fonts.fallback_serif);
    database.set_sans_serif_family(&fonts.fallback_sans);
    database.set_monospace_family(&fonts.fallback_mono);
    Arc::new(database)
}

pub fn outline(svg: &str, fonts: &PdfExportOptions,
    database: Arc<usvg::fontdb::Database>) -> Result<(String, Vec<String>), String> {
    let mut options = usvg::Options::default();
    options.fontdb = database;
    options.font_family = fonts.fallback_sans.clone();
    // Embedded SVG charts/pictures are not decoded by Android's BitmapFactory.
    // Rasterize only these image resources; the page itself remains vector Canvas.
    let default_data = usvg::ImageHrefResolver::default_data_resolver();
    options.image_href_resolver.resolve_data = Box::new(move |mime, data, opts| {
        if mime != "image/svg+xml" { return default_data(mime, data, opts); }
        // A custom image resolver starts a fresh SVG parser for each resource.
        // Bound nested SVG images even when the upstream parser restarts its limit.
        let allowed = IMAGE_DEPTH.with(|depth| {
            if depth.get() >= 8 { false } else { depth.set(depth.get() + 1); true }
        });
        if !allowed { return None; }
        let _guard = ImageDepthGuard;
        let tree = usvg::Tree::from_data(&data, opts).ok()?;
        let size = tree.size();
        let scale = (4096.0 / size.width().max(size.height())).min(1.0)
            .min((8_000_000.0 / (size.width() * size.height())).sqrt());
        let mut pixels = resvg::tiny_skia::Pixmap::new(
            (size.width() * scale).ceil().max(1.0) as u32,
            (size.height() * scale).ceil().max(1.0) as u32)?;
        resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(scale, scale),
            &mut pixels.as_mut());
        Some(usvg::ImageKind::PNG(Arc::new(pixels.encode_png().ok()?)))
    });
    let svg = apply_pdf_font_options(svg, fonts);
    let (svg, bold) = prepare_svg_with_synthetic_bold(&svg, &options)?;
    let (tree, italic) = parse_svg_with_synthetic_italic(&svg, &options)?;
    let svg = tree.to_string(&usvg::WriteOptions::default());
    let mut warnings = Vec::new();
    if bold.unsupported_texts > 0 || italic.unsupported_texts > 0 {
        warnings.push("일부 글자의 굵기·기울임을 정확히 재현하지 못했습니다.".into());
    }
    if svg.contains("<filter") {
        warnings.push("일부 그림자·필터 효과는 Android 표시 엔진에서 생략됩니다.".into());
    }
    Ok((svg, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_vector_geometry_clips_and_embedded_svg_images() {
        let options = PdfExportOptions::default();
        let source = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
          <defs><clipPath id="clip"><rect width="100" height="80"/></clipPath></defs>
          <g clip-path="url(#clip)" transform="rotate(10 50 50)">
            <path d="M0 0L150 80" stroke="red" stroke-width="2"/>
            <ellipse cx="50" cy="50" rx="20" ry="10" fill="blue"/>
          </g><image x="150" y="0" width="10" height="10" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSJyZWQiLz48L3N2Zz4="/></svg>"##;
        let (output, _) = outline(source, &options, font_database(&options)).unwrap();
        assert!(output.contains("clipPath"));
        assert!(output.contains("<path"));
        assert!(output.contains("transform="));
        assert!(!output.contains("<text"));
        assert!(output.contains("data:image/png"));
        assert!(!output.contains("data:image/svg+xml"));
    }
}
