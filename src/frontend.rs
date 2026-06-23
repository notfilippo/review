use include_dir::{Dir, include_dir};

static FRONTEND: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/internal/frontend");

pub struct Asset {
    pub bytes: &'static [u8],
    pub content_type: String,
}

pub fn asset(path: &str) -> Option<Asset> {
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let file = FRONTEND.get_file(path)?;
    Some(Asset {
        bytes: file.contents(),
        content_type: content_type(path),
    })
}

fn content_type(path: &str) -> String {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    if mime.type_() == mime_guess::mime::TEXT {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    }
}
