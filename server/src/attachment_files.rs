use crate::app::AppState;
use crate::s3;
use crate::trpc::ProcedureContext;
use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub(crate) struct StagedAttachmentDeletion {
    location: Option<StagedDeletionLocation>,
}

enum StagedDeletionLocation {
    Local {
        original_path: PathBuf,
        staged_path: PathBuf,
        journal_path: PathBuf,
    },
    S3 {
        config: s3::S3Config,
        original_key: String,
        staged_key: String,
        journal_path: PathBuf,
    },
}

pub(crate) struct StagedAttachmentMove {
    location: Option<StagedMoveLocation>,
}

enum StagedMoveLocation {
    Local {
        old_path: PathBuf,
        new_path: PathBuf,
        journal_path: PathBuf,
    },
    S3 {
        config: s3::S3Config,
        old_key: String,
        new_key: String,
        journal_path: PathBuf,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AttachmentOperationJournal {
    DeleteLocal {
        api_path: String,
        staged_name: String,
    },
    DeleteS3 {
        api_path: String,
        staged_key: String,
    },
    MoveLocal {
        attachment_id: i32,
        old_api_path: String,
        new_api_path: String,
    },
    MoveS3 {
        attachment_id: i32,
        old_api_path: String,
        new_api_path: String,
    },
}

/// Move physical files out of their public API paths before deleting database
/// rows. A failed database transaction can then restore every file, while a
/// committed transaction only needs to remove the private staging copies.
pub(crate) async fn stage_attachment_deletions(
    ctx: &ProcedureContext,
    api_paths: &[String],
) -> anyhow::Result<Vec<StagedAttachmentDeletion>> {
    let mut unique_paths = HashSet::new();
    let mut staged = Vec::new();
    for api_path in api_paths {
        if api_path.trim().is_empty() || !unique_paths.insert(api_path.as_str()) {
            continue;
        }
        match stage_attachment_deletion(ctx, api_path).await {
            Ok(item) => staged.push(item),
            Err(stage_error) => {
                if let Err(rollback_error) = rollback_attachment_deletions(staged).await {
                    return Err(stage_error.context(format!(
                        "physical attachment staging failed and rollback also failed: {rollback_error}"
                    )));
                }
                return Err(stage_error);
            }
        }
    }
    Ok(staged)
}

async fn stage_attachment_deletion(
    ctx: &ProcedureContext,
    api_path: &str,
) -> anyhow::Result<StagedAttachmentDeletion> {
    if api_path.trim().is_empty() {
        return Ok(StagedAttachmentDeletion { location: None });
    }

    if api_path.starts_with("/api/s3file/") {
        let config = s3::load_s3_config(&ctx.state)
            .await?
            .ok_or_else(|| anyhow!("S3 config not found"))?;
        let key = s3_key_from_api_path(api_path).ok_or_else(|| anyhow!("Invalid S3 path"))?;
        if !s3::object_exists(&config, &key).await? {
            return Ok(StagedAttachmentDeletion { location: None });
        }
        let staged_key = format!(
            "{}.__blinkora-trash/{}",
            config.custom_path,
            uuid::Uuid::new_v4()
        );
        let journal_path = write_operation_journal(
            &ctx.state,
            &AttachmentOperationJournal::DeleteS3 {
                api_path: api_path.to_string(),
                staged_key: staged_key.clone(),
            },
        )
        .await?;
        if let Err(error) = s3::copy_object(&config, &key, &staged_key).await {
            remove_operation_journal(&journal_path).await?;
            return Err(error).context("stage S3 attachment for deletion");
        }
        if let Err(error) = s3::delete_object(&config, &key).await {
            if s3::delete_object(&config, &staged_key).await.is_ok() {
                remove_operation_journal(&journal_path).await?;
            }
            return Err(error).context("hide staged S3 attachment from its public path");
        }
        return Ok(StagedAttachmentDeletion {
            location: Some(StagedDeletionLocation::S3 {
                config,
                original_key: key,
                staged_key,
                journal_path,
            }),
        });
    }

    if api_path.starts_with("/api/file/") {
        let relative_path =
            api_file_relative_path(api_path).ok_or_else(|| anyhow!("Invalid file path"))?;
        let files_root = Path::new(&ctx.state.config.data_dir).join("files");
        let original_path = files_root.join(relative_path);
        if !fs::try_exists(&original_path).await? {
            return Ok(StagedAttachmentDeletion { location: None });
        }
        let staging_dir = files_root.join(".blinkora-trash");
        create_private_dir(&staging_dir).await?;
        let staged_name = uuid::Uuid::new_v4().to_string();
        let staged_path = staging_dir.join(&staged_name);
        let journal_path = write_operation_journal(
            &ctx.state,
            &AttachmentOperationJournal::DeleteLocal {
                api_path: api_path.to_string(),
                staged_name,
            },
        )
        .await?;
        if let Err(error) = fs::rename(&original_path, &staged_path).await {
            remove_operation_journal(&journal_path).await?;
            return Err(error)
                .with_context(|| format!("stage local attachment {}", original_path.display()));
        }
        return Ok(StagedAttachmentDeletion {
            location: Some(StagedDeletionLocation::Local {
                original_path,
                staged_path,
                journal_path,
            }),
        });
    }

    bail!("Unsupported attachment path")
}

pub(crate) async fn rollback_attachment_deletions(
    mut staged: Vec<StagedAttachmentDeletion>,
) -> anyhow::Result<()> {
    let mut first_error = None;
    while let Some(item) = staged.pop() {
        if let Err(error) = item.rollback().await {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(crate) async fn finalize_attachment_deletions(
    staged: Vec<StagedAttachmentDeletion>,
) -> anyhow::Result<()> {
    let mut first_error = None;
    for item in staged {
        if let Err(error) = item.finalize().await {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

impl StagedAttachmentDeletion {
    async fn rollback(self) -> anyhow::Result<()> {
        match self.location {
            None => Ok(()),
            Some(StagedDeletionLocation::Local {
                original_path,
                staged_path,
                journal_path,
            }) => {
                if let Some(parent) = original_path.parent() {
                    create_private_dir(parent).await?;
                }
                fs::rename(&staged_path, &original_path)
                    .await
                    .context("restore staged local attachment")?;
                remove_operation_journal(&journal_path).await
            }
            Some(StagedDeletionLocation::S3 {
                config,
                original_key,
                staged_key,
                journal_path,
            }) => {
                s3::copy_object(&config, &staged_key, &original_key)
                    .await
                    .context("restore staged S3 attachment")?;
                s3::delete_object(&config, &staged_key)
                    .await
                    .context("remove restored S3 staging object")?;
                remove_operation_journal(&journal_path).await
            }
        }
    }

    async fn finalize(self) -> anyhow::Result<()> {
        match self.location {
            None => Ok(()),
            Some(StagedDeletionLocation::Local {
                staged_path,
                journal_path,
                ..
            }) => {
                match fs::remove_file(&staged_path).await {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error).context("remove staged local attachment"),
                }
                remove_operation_journal(&journal_path).await
            }
            Some(StagedDeletionLocation::S3 {
                config,
                staged_key,
                journal_path,
                ..
            }) => {
                s3::delete_object(&config, &staged_key)
                    .await
                    .context("remove staged S3 attachment")?;
                remove_operation_journal(&journal_path).await
            }
        }
    }
}

pub(crate) async fn stage_attachment_move(
    ctx: &ProcedureContext,
    attachment_id: i32,
    old_api_path: &str,
    new_api_path: &str,
    allow_missing: bool,
) -> anyhow::Result<StagedAttachmentMove> {
    if old_api_path == new_api_path {
        return Ok(StagedAttachmentMove { location: None });
    }
    if old_api_path.starts_with("/api/s3file/") || new_api_path.starts_with("/api/s3file/") {
        if !old_api_path.starts_with("/api/s3file/") || !new_api_path.starts_with("/api/s3file/") {
            bail!("Cannot move an attachment between local and S3 storage");
        }
        let config = s3::load_s3_config(&ctx.state)
            .await?
            .ok_or_else(|| anyhow!("S3 config not found"))?;
        let old_key =
            s3_key_from_api_path(old_api_path).ok_or_else(|| anyhow!("Invalid S3 path"))?;
        let new_key =
            s3_key_from_api_path(new_api_path).ok_or_else(|| anyhow!("Invalid S3 path"))?;
        if s3::object_exists(&config, &new_key).await? {
            bail!("Attachment destination already exists");
        }
        let journal_path = write_operation_journal(
            &ctx.state,
            &AttachmentOperationJournal::MoveS3 {
                attachment_id,
                old_api_path: old_api_path.to_string(),
                new_api_path: new_api_path.to_string(),
            },
        )
        .await?;
        if let Err(error) = s3::copy_object(&config, &old_key, &new_key).await {
            remove_operation_journal(&journal_path).await?;
            if allow_missing {
                return Ok(StagedAttachmentMove { location: None });
            }
            return Err(error).context("copy S3 attachment to its new path");
        }
        if let Err(error) = s3::delete_object(&config, &old_key).await {
            if s3::delete_object(&config, &new_key).await.is_ok() {
                remove_operation_journal(&journal_path).await?;
            }
            return Err(error).context("remove S3 attachment from its old path");
        }
        return Ok(StagedAttachmentMove {
            location: Some(StagedMoveLocation::S3 {
                config,
                old_key,
                new_key,
                journal_path,
            }),
        });
    }

    let old_relative =
        api_file_relative_path(old_api_path).ok_or_else(|| anyhow!("Invalid file path"))?;
    let new_relative =
        api_file_relative_path(new_api_path).ok_or_else(|| anyhow!("Invalid file path"))?;
    let files_root = Path::new(&ctx.state.config.data_dir).join("files");
    let old_path = files_root.join(old_relative);
    let new_path = files_root.join(new_relative);
    if !fs::try_exists(&old_path).await? {
        if allow_missing {
            return Ok(StagedAttachmentMove { location: None });
        }
        bail!("Attachment file is missing")
    }
    if fs::try_exists(&new_path).await? {
        bail!("Attachment destination already exists");
    }
    if let Some(parent) = new_path.parent() {
        create_private_dir(parent).await?;
    }
    let journal_path = write_operation_journal(
        &ctx.state,
        &AttachmentOperationJournal::MoveLocal {
            attachment_id,
            old_api_path: old_api_path.to_string(),
            new_api_path: new_api_path.to_string(),
        },
    )
    .await?;
    if let Err(error) = fs::rename(&old_path, &new_path).await {
        remove_operation_journal(&journal_path).await?;
        return Err(error).context("move local attachment");
    }
    Ok(StagedAttachmentMove {
        location: Some(StagedMoveLocation::Local {
            old_path,
            new_path,
            journal_path,
        }),
    })
}

pub(crate) async fn rollback_attachment_moves(
    mut staged: Vec<StagedAttachmentMove>,
) -> anyhow::Result<()> {
    let mut first_error = None;
    while let Some(item) = staged.pop() {
        if let Err(error) = item.rollback().await {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(crate) async fn finalize_attachment_moves(
    staged: Vec<StagedAttachmentMove>,
) -> anyhow::Result<()> {
    let mut first_error = None;
    for item in staged {
        if let Err(error) = item.finalize().await {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

impl StagedAttachmentMove {
    async fn rollback(self) -> anyhow::Result<()> {
        match self.location {
            None => Ok(()),
            Some(StagedMoveLocation::Local {
                old_path,
                new_path,
                journal_path,
            }) => {
                if let Some(parent) = old_path.parent() {
                    create_private_dir(parent).await?;
                }
                fs::rename(&new_path, &old_path)
                    .await
                    .context("restore moved local attachment")?;
                remove_operation_journal(&journal_path).await
            }
            Some(StagedMoveLocation::S3 {
                config,
                old_key,
                new_key,
                journal_path,
            }) => {
                s3::copy_object(&config, &new_key, &old_key)
                    .await
                    .context("restore moved S3 attachment")?;
                s3::delete_object(&config, &new_key)
                    .await
                    .context("remove rolled-back S3 attachment")?;
                remove_operation_journal(&journal_path).await
            }
        }
    }

    async fn finalize(self) -> anyhow::Result<()> {
        match self.location {
            None => Ok(()),
            Some(StagedMoveLocation::Local { journal_path, .. })
            | Some(StagedMoveLocation::S3 { journal_path, .. }) => {
                remove_operation_journal(&journal_path).await
            }
        }
    }
}

pub(crate) async fn recover_pending_attachment_operations(
    state: &AppState,
) -> anyhow::Result<usize> {
    let journal_dir = operation_journal_dir(state);
    if !fs::try_exists(&journal_dir).await? {
        return Ok(0);
    }

    let mut journal_paths = Vec::new();
    let mut entries = fs::read_dir(&journal_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        match path.extension().and_then(|value| value.to_str()) {
            Some("json") => journal_paths.push(path),
            Some("tmp") => {
                fs::remove_file(path).await?;
            }
            _ => bail!("Unexpected file in attachment operation journal"),
        }
    }
    journal_paths.sort();

    for journal_path in &journal_paths {
        let bytes = fs::read(journal_path)
            .await
            .context("read attachment operation journal")?;
        let operation: AttachmentOperationJournal =
            serde_json::from_slice(&bytes).context("parse attachment operation journal")?;
        recover_operation(state, journal_path, operation).await?;
    }
    Ok(journal_paths.len())
}

async fn recover_operation(
    state: &AppState,
    journal_path: &Path,
    operation: AttachmentOperationJournal,
) -> anyhow::Result<()> {
    match operation {
        AttachmentOperationJournal::DeleteLocal {
            api_path,
            staged_name,
        } => {
            uuid::Uuid::parse_str(&staged_name)
                .map_err(|_| anyhow!("Invalid local attachment staging name"))?;
            let files_root = Path::new(&state.config.data_dir).join("files");
            let relative_path = api_file_relative_path(&api_path)
                .ok_or_else(|| anyhow!("Invalid local attachment journal path"))?;
            let original_path = files_root.join(relative_path);
            let staged_path = files_root.join(".blinkora-trash").join(staged_name);
            let row_exists = attachment_path_exists(state, &api_path).await?;
            let original_exists = fs::try_exists(&original_path).await?;
            let staged_exists = fs::try_exists(&staged_path).await?;
            if row_exists {
                match (original_exists, staged_exists) {
                    (true, false) => remove_operation_journal(journal_path).await,
                    (false, true) => {
                        if let Some(parent) = original_path.parent() {
                            create_private_dir(parent).await?;
                        }
                        fs::rename(staged_path, original_path).await?;
                        remove_operation_journal(journal_path).await
                    }
                    _ => bail!("Cannot safely recover a local attachment deletion"),
                }
            } else {
                match (original_exists, staged_exists) {
                    (false, true) => {
                        fs::remove_file(staged_path).await?;
                        remove_operation_journal(journal_path).await
                    }
                    (false, false) => remove_operation_journal(journal_path).await,
                    _ => bail!("Cannot safely finalize a local attachment deletion"),
                }
            }
        }
        AttachmentOperationJournal::DeleteS3 {
            api_path,
            staged_key,
        } => {
            let original_key = s3_key_from_api_path(&api_path)
                .ok_or_else(|| anyhow!("Invalid S3 attachment journal path"))?;
            validate_s3_key(&staged_key)
                .ok_or_else(|| anyhow!("Invalid S3 attachment staging key"))?;
            let config = s3::load_s3_config(state)
                .await?
                .ok_or_else(|| anyhow!("S3 config not found during attachment recovery"))?;
            let row_exists = attachment_path_exists(state, &api_path).await?;
            let original_exists = s3::object_exists(&config, &original_key).await?;
            let staged_exists = s3::object_exists(&config, &staged_key).await?;
            if row_exists {
                if original_exists {
                    if staged_exists {
                        s3::delete_object(&config, &staged_key).await?;
                    }
                    remove_operation_journal(journal_path).await
                } else if staged_exists {
                    s3::copy_object(&config, &staged_key, &original_key).await?;
                    s3::delete_object(&config, &staged_key).await?;
                    remove_operation_journal(journal_path).await
                } else {
                    bail!("Cannot safely recover an S3 attachment deletion")
                }
            } else if !original_exists && staged_exists {
                s3::delete_object(&config, &staged_key).await?;
                remove_operation_journal(journal_path).await
            } else if !original_exists && !staged_exists {
                remove_operation_journal(journal_path).await
            } else {
                bail!("Cannot safely finalize an S3 attachment deletion")
            }
        }
        AttachmentOperationJournal::MoveLocal {
            attachment_id,
            old_api_path,
            new_api_path,
        } => {
            let files_root = Path::new(&state.config.data_dir).join("files");
            let old_path = files_root.join(
                api_file_relative_path(&old_api_path)
                    .ok_or_else(|| anyhow!("Invalid old local attachment journal path"))?,
            );
            let new_path = files_root.join(
                api_file_relative_path(&new_api_path)
                    .ok_or_else(|| anyhow!("Invalid new local attachment journal path"))?,
            );
            let database_path = attachment_path_by_id(state, attachment_id).await?;
            recover_local_move(
                journal_path,
                database_path.as_deref(),
                &old_api_path,
                &new_api_path,
                old_path,
                new_path,
            )
            .await
        }
        AttachmentOperationJournal::MoveS3 {
            attachment_id,
            old_api_path,
            new_api_path,
        } => {
            let old_key = s3_key_from_api_path(&old_api_path)
                .ok_or_else(|| anyhow!("Invalid old S3 attachment journal path"))?;
            let new_key = s3_key_from_api_path(&new_api_path)
                .ok_or_else(|| anyhow!("Invalid new S3 attachment journal path"))?;
            let config = s3::load_s3_config(state)
                .await?
                .ok_or_else(|| anyhow!("S3 config not found during attachment recovery"))?;
            let database_path = attachment_path_by_id(state, attachment_id).await?;
            recover_s3_move(
                journal_path,
                database_path.as_deref(),
                &old_api_path,
                &new_api_path,
                &config,
                &old_key,
                &new_key,
            )
            .await
        }
    }
}

async fn recover_local_move(
    journal_path: &Path,
    database_path: Option<&str>,
    old_api_path: &str,
    new_api_path: &str,
    old_path: PathBuf,
    new_path: PathBuf,
) -> anyhow::Result<()> {
    let old_exists = fs::try_exists(&old_path).await?;
    let new_exists = fs::try_exists(&new_path).await?;
    if database_path == Some(old_api_path) {
        match (old_exists, new_exists) {
            (true, false) => remove_operation_journal(journal_path).await,
            (false, true) => {
                if let Some(parent) = old_path.parent() {
                    create_private_dir(parent).await?;
                }
                fs::rename(new_path, old_path).await?;
                remove_operation_journal(journal_path).await
            }
            _ => bail!("Cannot safely roll back a local attachment move"),
        }
    } else if database_path == Some(new_api_path) {
        match (old_exists, new_exists) {
            (false, true) => remove_operation_journal(journal_path).await,
            (true, false) => {
                if let Some(parent) = new_path.parent() {
                    create_private_dir(parent).await?;
                }
                fs::rename(old_path, new_path).await?;
                remove_operation_journal(journal_path).await
            }
            _ => bail!("Cannot safely finish a local attachment move"),
        }
    } else {
        bail!("Attachment move journal does not match its database row")
    }
}

#[allow(clippy::too_many_arguments)]
async fn recover_s3_move(
    journal_path: &Path,
    database_path: Option<&str>,
    old_api_path: &str,
    new_api_path: &str,
    config: &s3::S3Config,
    old_key: &str,
    new_key: &str,
) -> anyhow::Result<()> {
    let old_exists = s3::object_exists(config, old_key).await?;
    let new_exists = s3::object_exists(config, new_key).await?;
    if database_path == Some(old_api_path) {
        if old_exists {
            if new_exists {
                s3::delete_object(config, new_key).await?;
            }
            remove_operation_journal(journal_path).await
        } else if new_exists {
            s3::copy_object(config, new_key, old_key).await?;
            s3::delete_object(config, new_key).await?;
            remove_operation_journal(journal_path).await
        } else {
            bail!("Cannot safely roll back an S3 attachment move")
        }
    } else if database_path == Some(new_api_path) {
        if new_exists && !old_exists {
            remove_operation_journal(journal_path).await
        } else if old_exists && !new_exists {
            s3::copy_object(config, old_key, new_key).await?;
            s3::delete_object(config, old_key).await?;
            remove_operation_journal(journal_path).await
        } else {
            bail!("Cannot safely finish an S3 attachment move")
        }
    } else {
        bail!("Attachment move journal does not match its database row")
    }
}

async fn attachment_path_exists(state: &AppState, path: &str) -> anyhow::Result<bool> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE path=$1")
        .bind(path)
        .fetch_one(state.pool())
        .await?;
    Ok(count > 0)
}

async fn attachment_path_by_id(
    state: &AppState,
    attachment_id: i32,
) -> anyhow::Result<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT path FROM attachments WHERE id=$1")
            .bind(attachment_id)
            .fetch_optional(state.pool())
            .await?,
    )
}

async fn write_operation_journal(
    state: &AppState,
    operation: &AttachmentOperationJournal,
) -> anyhow::Result<PathBuf> {
    let journal_dir = operation_journal_dir(state);
    create_private_dir(&journal_dir).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let temporary_path = journal_dir.join(format!(".{id}.tmp"));
    let journal_path = journal_dir.join(format!("{id}.json"));
    let bytes = serde_json::to_vec(operation)?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .await?;
    set_private_file_permissions(&temporary_path).await?;
    file.write_all(&bytes).await?;
    file.sync_all().await?;
    drop(file);
    fs::rename(&temporary_path, &journal_path).await?;
    sync_directory(&journal_dir).await?;
    Ok(journal_path)
}

async fn remove_operation_journal(path: &Path) -> anyhow::Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    if let Some(parent) = path.parent() {
        sync_directory(parent).await?;
    }
    Ok(())
}

fn operation_journal_dir(state: &AppState) -> PathBuf {
    Path::new(&state.config.data_dir).join(".blinkora-file-operations")
}

async fn set_private_file_permissions(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(())
}

async fn sync_directory(path: &Path) -> anyhow::Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || std::fs::File::open(path)?.sync_all())
        .await
        .context("join directory sync task")??;
    Ok(())
}

async fn create_private_dir(path: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(path).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Ok(())
}

pub(crate) fn api_file_relative_path(path: &str) -> Option<PathBuf> {
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

pub(crate) fn s3_key_from_api_path(path: &str) -> Option<String> {
    let key = path.strip_prefix("/api/s3file/")?;
    validate_s3_key(key).map(ToString::to_string)
}

fn validate_s3_key(key: &str) -> Option<&str> {
    if key.contains('\0')
        || key.contains('\\')
        || key.starts_with('/')
        || key.split('/').any(|part| part == "..")
    {
        return None;
    }
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::test_support::HandlerTestFixture;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    async fn configure_test_s3(fixture: &HandlerTestFixture, endpoint: &str) {
        let values = [
            ("objectStorage", json!("s3")),
            ("s3Endpoint", json!(endpoint)),
            ("s3Region", json!("test-region")),
            ("s3Bucket", json!("test-bucket")),
            ("s3AccessKeyId", json!("test-key")),
            ("s3AccessKeySecret", json!("test-secret")),
            ("s3CustomPath", json!("")),
            ("s3ForcePathStyle", json!(true)),
        ];
        for (key, value) in values {
            sqlx::query(r#"INSERT INTO config (key, config) VALUES ($1, $2)"#)
                .bind(key)
                .bind(crate::util::config_json(value))
                .execute(&fixture.pool)
                .await
                .unwrap();
        }
    }

    async fn seed_attachment(fixture: &HandlerTestFixture, api_path: &str) -> i32 {
        let name = api_path.rsplit('/').next().unwrap();
        sqlx::query_scalar(
            r#"INSERT INTO attachments
               (name, path, size, type, "accountId", "workspaceId", "perfixPath", depth, "sortOrder", "updatedAt")
               VALUES ($1, $2, 16, 'text/plain', $3, $4, '', 0, 0, blinkora_now())
               RETURNING id"#,
        )
        .bind(name)
        .bind(api_path)
        .bind(fixture.account_id)
        .bind(fixture.workspace_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap()
    }

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

    #[tokio::test]
    async fn staged_local_delete_can_be_rolled_back_or_finalized() {
        let fixture = HandlerTestFixture::new("attachment-delete-staging").await;
        let file_path = fixture.data_dir.join("files/nested/example.txt");
        create_private_dir(file_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&file_path, b"attachment bytes").await.unwrap();
        let api_paths = vec!["/api/file/nested/example.txt".to_string()];

        let staged = stage_attachment_deletions(&fixture.ctx, &api_paths)
            .await
            .unwrap();
        assert!(!fs::try_exists(&file_path).await.unwrap());
        rollback_attachment_deletions(staged).await.unwrap();
        assert_eq!(fs::read(&file_path).await.unwrap(), b"attachment bytes");

        let staged = stage_attachment_deletions(&fixture.ctx, &api_paths)
            .await
            .unwrap();
        finalize_attachment_deletions(staged).await.unwrap();
        assert!(!fs::try_exists(&file_path).await.unwrap());
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn missing_s3_attachment_is_treated_as_already_deleted() {
        let fixture = HandlerTestFixture::new("missing-s3-attachment-delete").await;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (request_tx, request_rx) = mpsc::channel();
        let responder = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).unwrap();
            request_tx
                .send(String::from_utf8_lossy(&request[..count]).into_owned())
                .unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        configure_test_s3(&fixture, &endpoint).await;

        let staged = stage_attachment_deletions(
            &fixture.ctx,
            &["/api/s3file/missing-image.jpg".to_string()],
        )
        .await
        .expect("a missing S3 object must not block attachment cleanup");

        assert!(matches!(
            staged.as_slice(),
            [StagedAttachmentDeletion { location: None }]
        ));
        assert!(request_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .starts_with("HEAD /test-bucket/missing-image.jpg "));
        responder.join().unwrap();
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn staged_local_move_can_restore_the_original_path() {
        let fixture = HandlerTestFixture::new("attachment-move-staging").await;
        let old_path = fixture.data_dir.join("files/source.txt");
        let new_path = fixture.data_dir.join("files/nested/target.txt");
        create_private_dir(old_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&old_path, b"move bytes").await.unwrap();

        let staged = stage_attachment_move(
            &fixture.ctx,
            1,
            "/api/file/source.txt",
            "/api/file/nested/target.txt",
            false,
        )
        .await
        .unwrap();
        assert!(!fs::try_exists(&old_path).await.unwrap());
        assert_eq!(fs::read(&new_path).await.unwrap(), b"move bytes");

        rollback_attachment_moves(vec![staged]).await.unwrap();
        assert_eq!(fs::read(&old_path).await.unwrap(), b"move bytes");
        assert!(!fs::try_exists(&new_path).await.unwrap());
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn local_move_never_overwrites_an_existing_destination() {
        let fixture = HandlerTestFixture::new("attachment-move-collision").await;
        let old_path = fixture.data_dir.join("files/source.txt");
        let new_path = fixture.data_dir.join("files/target.txt");
        create_private_dir(old_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&old_path, b"source bytes").await.unwrap();
        fs::write(&new_path, b"target bytes").await.unwrap();

        let result = stage_attachment_move(
            &fixture.ctx,
            1,
            "/api/file/source.txt",
            "/api/file/target.txt",
            false,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(fs::read(&old_path).await.unwrap(), b"source bytes");
        assert_eq!(fs::read(&new_path).await.unwrap(), b"target bytes");
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn startup_recovery_resolves_interrupted_local_delete_from_database_state() {
        let fixture = HandlerTestFixture::new("attachment-delete-recovery").await;
        let api_path = "/api/file/recover-delete.txt";
        let attachment_id = seed_attachment(&fixture, api_path).await;
        let file_path = fixture.data_dir.join("files/recover-delete.txt");
        create_private_dir(file_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&file_path, b"recover delete bytes")
            .await
            .unwrap();

        let staged = stage_attachment_deletions(&fixture.ctx, &[api_path.to_string()])
            .await
            .unwrap();
        drop(staged);
        assert!(!fs::try_exists(&file_path).await.unwrap());
        assert_eq!(
            recover_pending_attachment_operations(&fixture.ctx.state)
                .await
                .unwrap(),
            1
        );
        assert_eq!(fs::read(&file_path).await.unwrap(), b"recover delete bytes");

        let staged = stage_attachment_deletions(&fixture.ctx, &[api_path.to_string()])
            .await
            .unwrap();
        sqlx::query("DELETE FROM attachments WHERE id=$1")
            .bind(attachment_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        drop(staged);
        assert_eq!(
            recover_pending_attachment_operations(&fixture.ctx.state)
                .await
                .unwrap(),
            1
        );
        assert!(!fs::try_exists(&file_path).await.unwrap());
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn startup_recovery_resolves_interrupted_local_move_from_database_state() {
        let fixture = HandlerTestFixture::new("attachment-move-recovery").await;
        let old_api_path = "/api/file/recover-move.txt";
        let new_api_path = "/api/file/folder/recover-move.txt";
        let attachment_id = seed_attachment(&fixture, old_api_path).await;
        let old_path = fixture.data_dir.join("files/recover-move.txt");
        let new_path = fixture.data_dir.join("files/folder/recover-move.txt");
        create_private_dir(old_path.parent().unwrap())
            .await
            .unwrap();
        fs::write(&old_path, b"recover move bytes").await.unwrap();

        let staged = stage_attachment_move(
            &fixture.ctx,
            attachment_id,
            old_api_path,
            new_api_path,
            false,
        )
        .await
        .unwrap();
        drop(staged);
        assert_eq!(
            recover_pending_attachment_operations(&fixture.ctx.state)
                .await
                .unwrap(),
            1
        );
        assert_eq!(fs::read(&old_path).await.unwrap(), b"recover move bytes");
        assert!(!fs::try_exists(&new_path).await.unwrap());

        let staged = stage_attachment_move(
            &fixture.ctx,
            attachment_id,
            old_api_path,
            new_api_path,
            false,
        )
        .await
        .unwrap();
        sqlx::query("UPDATE attachments SET path=$1 WHERE id=$2")
            .bind(new_api_path)
            .bind(attachment_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        drop(staged);
        assert_eq!(
            recover_pending_attachment_operations(&fixture.ctx.state)
                .await
                .unwrap(),
            1
        );
        assert!(!fs::try_exists(&old_path).await.unwrap());
        assert_eq!(fs::read(&new_path).await.unwrap(), b"recover move bytes");
        fixture.cleanup().await;
    }
}
