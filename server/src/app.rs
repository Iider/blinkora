use crate::config::Config;
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard};

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<AppStateInner>,
}

pub struct AppStateInner {
    pub config: Config,
    pub pool: SqlitePool,
    /// SQLite has one writer per database file. The product supports one
    /// Blinkora service process, so serializing only mutations here prevents
    /// stale read-then-write races while preserving concurrent reads.
    write_gate: Arc<Mutex<()>>,
}

impl AppState {
    pub fn new(config: Config, pool: SqlitePool) -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                config,
                pool,
                write_gate: Arc::new(Mutex::new(())),
            }),
        }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.inner.pool
    }

    pub async fn write_guard(&self) -> OwnedMutexGuard<()> {
        self.inner.write_gate.clone().lock_owned().await
    }
}

impl std::ops::Deref for AppState {
    type Target = AppStateInner;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
