use crate::app::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use std::path::{Component, Path, PathBuf};
use tokio::fs;

pub async fn static_handler(State(state): State<AppState>, request: Request<Body>) -> Response {
    let public_path = PathBuf::from(&state.config.public_path);
    let request_path = request.uri().path();
    let relative = sanitize_path(request_path);
    let file_path = public_path.join(&relative);

    if let Ok(metadata) = fs::metadata(&file_path).await {
        if metadata.is_file() {
            return serve_file(file_path, request_path, false).await;
        }
    }

    if Path::new(request_path).extension().is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }

    serve_file(public_path.join("index.html"), "/index.html", true).await
}

async fn serve_file(path: PathBuf, request_path: &str, fallback: bool) -> Response {
    match fs::read(path).await {
        Ok(bytes) => {
            let mut response = (StatusCode::OK, bytes).into_response();
            set_cache_headers(response.headers_mut(), request_path, fallback);
            if let Some(content_type) = content_type(request_path) {
                response
                    .headers_mut()
                    .insert(header::CONTENT_TYPE, content_type.parse().unwrap());
            }
            response
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

fn sanitize_path(path: &str) -> PathBuf {
    let mut output = PathBuf::new();
    for component in Path::new(path.trim_start_matches('/')).components() {
        if let Component::Normal(part) = component {
            output.push(part);
        }
    }
    output
}

fn set_cache_headers(headers: &mut axum::http::HeaderMap, path: &str, fallback: bool) {
    let value = if fallback || path == "/" || path == "/index.html" || path.starts_with("/locales/")
    {
        "no-store"
    } else if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else if path.starts_with("/vditor-assets/") {
        "no-cache, max-age=0"
    } else {
        "public, max-age=3600"
    };
    headers.insert(header::CACHE_CONTROL, value.parse().unwrap());
    if value == "no-store" {
        headers.insert(header::PRAGMA, "no-cache".parse().unwrap());
        headers.insert(header::EXPIRES, "0".parse().unwrap());
    }
}

fn content_type(path: &str) -> Option<&'static str> {
    match Path::new(path).extension()?.to_str()? {
        "html" => Some("text/html; charset=utf-8"),
        "js" => Some("application/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "json" => Some("application/json; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        _ => None,
    }
}
