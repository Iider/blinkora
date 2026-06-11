use crate::s3;
use crate::trpc::ProcedureContext;
use anyhow::{anyhow, Context};
use std::path::{Path, PathBuf};
use tokio::fs;

pub(crate) async fn delete_physical_attachment(
    ctx: &ProcedureContext,
    api_path: &str,
) -> anyhow::Result<()> {
    if api_path.trim().is_empty() {
        return Ok(());
    }

    if api_path.starts_with("/api/s3file/") {
        let config = s3::load_s3_config(&ctx.state)
            .await?
            .ok_or_else(|| anyhow!("S3 config not found"))?;
        let key = s3_key_from_api_path(api_path).ok_or_else(|| anyhow!("Invalid S3 path"))?;
        s3::delete_object(&config, &key)
            .await
            .with_context(|| format!("delete S3 object {key}"))?;
        return Ok(());
    }

    if api_path.starts_with("/api/file/") {
        let relative_path =
            api_file_relative_path(api_path).ok_or_else(|| anyhow!("Invalid file path"))?;
        let path = Path::new(&ctx.state.config.data_dir)
            .join("files")
            .join(relative_path);
        match fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.into()),
        }
    } else {
        Ok(())
    }
}

fn api_file_relative_path(path: &str) -> Option<PathBuf> {
    let relative = path.strip_prefix("/api/file/")?;
    if relative.contains('\0')
        || relative.contains('\\')
        || relative.starts_with('/')
        || relative.split('/').any(|part| part == "..")
    {
        return None;
    }
    Some(PathBuf::from(relative))
}

fn s3_key_from_api_path(path: &str) -> Option<String> {
    let key = path.strip_prefix("/api/s3file/")?;
    if key.contains('\0')
        || key.contains('\\')
        || key.starts_with('/')
        || key.split('/').any(|part| part == "..")
    {
        return None;
    }
    Some(key.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_local_attachment_paths() {
        assert_eq!(
            api_file_relative_path("/api/file/a/b.txt"),
            Some(PathBuf::from("a/b.txt"))
        );
        assert!(api_file_relative_path("/api/file/../secret.txt").is_none());
        assert!(api_file_relative_path("/api/s3file/a/b.txt").is_none());
    }

    #[test]
    fn validates_s3_attachment_keys() {
        assert_eq!(
            s3_key_from_api_path("/api/s3file/prefix/a.txt"),
            Some("prefix/a.txt".to_string())
        );
        assert!(s3_key_from_api_path("/api/s3file/../secret.txt").is_none());
        assert!(s3_key_from_api_path("/api/file/a.txt").is_none());
    }
}
