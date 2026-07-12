use crate::app::AppState;
use crate::auth::CurrentUser;
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;

const MCP_GUIDE_MD: &str =
    include_str!("../../../.agents/skills/blinkora-workspace/references/mcp-guide.md");
const BLINKORA_WORKSPACE_SKILL_MD: &str =
    include_str!("../../../.agents/skills/blinkora-workspace/SKILL.md");
const MCP_SSE_PYTHON_CLIENT_REFERENCE: &str =
    include_str!("../../../.agents/skills/blinkora-workspace/references/mcp-sse-python-client.md");

const WORKSPACE_SKILL_FILES: [(&str, &str); 3] = [
    ("blinkora-workspace/SKILL.md", BLINKORA_WORKSPACE_SKILL_MD),
    ("blinkora-workspace/references/mcp-guide.md", MCP_GUIDE_MD),
    (
        "blinkora-workspace/references/mcp-sse-python-client.md",
        MCP_SSE_PYTHON_CLIENT_REFERENCE,
    ),
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/mcp-guide.md", get(mcp_guide))
        .route("/blinkora-workspace/SKILL.md", get(skill_md))
        .route("/blinkora-workspace.zip", get(skill_zip))
}

async fn mcp_guide(_user: CurrentUser) -> Response {
    markdown_response(MCP_GUIDE_MD)
}

async fn skill_md(_user: CurrentUser) -> Response {
    let mut response = markdown_response(BLINKORA_WORKSPACE_SKILL_MD);
    response.headers_mut().insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"SKILL.md\""),
    );
    response
}

async fn skill_zip(_user: CurrentUser) -> Response {
    match build_skill_zip() {
        Ok(body) => {
            let mut response = (StatusCode::OK, body).into_response();
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("application/zip"));
            response.headers_mut().insert(
                CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"blinkora-workspace.zip\""),
            );
            response
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to build skill zip: {error}"),
        )
            .into_response(),
    }
}

fn markdown_response(content: &'static str) -> Response {
    let mut response = (StatusCode::OK, content).into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/markdown; charset=utf-8"),
    );
    response
}

fn build_skill_zip() -> anyhow::Result<Vec<u8>> {
    let cursor = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);

    for (path, content) in WORKSPACE_SKILL_FILES {
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file(path, options)?;
        zip.write_all(content.as_bytes())?;
    }

    Ok(zip.finish()?.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn workspace_skill_zip_contains_the_full_canonical_bundle() {
        let bytes = build_skill_zip().expect("build workspace skill zip");
        let mut archive =
            zip::ZipArchive::new(Cursor::new(bytes)).expect("open workspace skill zip");

        let actual_paths = (0..archive.len())
            .map(|index| {
                archive
                    .by_index(index)
                    .expect("read workspace skill zip entry")
                    .name()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        let expected_paths = WORKSPACE_SKILL_FILES
            .iter()
            .map(|(path, _)| (*path).to_owned())
            .collect::<Vec<_>>();
        assert_eq!(actual_paths, expected_paths);

        for (path, expected_content) in WORKSPACE_SKILL_FILES {
            let mut actual_content = String::new();
            archive
                .by_name(path)
                .expect("open canonical skill file")
                .read_to_string(&mut actual_content)
                .expect("read canonical skill file");
            assert_eq!(
                actual_content, expected_content,
                "{path} drifted from its source"
            );
        }
    }
}
