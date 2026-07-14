use anyhow::{bail, Result};
use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: String,
    pub auth_secret: String,
    pub node_env: String,
    pub public_path: String,
    pub data_dir: String,
    pub schema_path: String,
}

impl Config {
    pub fn from_env() -> Self {
        let node_env = env_var("NODE_ENV", "development");
        let mut auth_secret = env_var("BLINKORA_SECRET", "");
        if auth_secret.is_empty() && node_env != "production" {
            auth_secret = "dev-only-insecure-secret".to_string();
        }
        Self {
            port: env_var("PORT", "6676"),
            auth_secret,
            node_env,
            public_path: env_var("PUBLIC_PATH", "./public"),
            data_dir: env_var("DATA_DIR", "./data"),
            schema_path: env_var("SCHEMA_PATH", "db/schema.sqlite.sql"),
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.node_env != "production" {
            return Ok(());
        }
        let secret = self.auth_secret.trim();
        if secret.is_empty()
            || secret == "<GENERATE_A_SECURE_SECRET>"
            || secret == "blinkora-secret-change-in-production"
            || secret == "dev-only-insecure-secret"
        {
            bail!("BLINKORA_SECRET must be set to a non-placeholder value in production");
        }
        Ok(())
    }
}

fn env_var(key: &str, fallback: &str) -> String {
    env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[cfg(test)]
mod tests {
    use super::Config;

    #[test]
    fn rejects_placeholder_secret_in_production() {
        let cfg = Config {
            port: "6676".into(),
            auth_secret: "dev-only-insecure-secret".into(),
            node_env: "production".into(),
            public_path: "./public".into(),
            data_dir: "./data".into(),
            schema_path: "db/schema.sqlite.sql".into(),
        };
        assert!(cfg.validate().is_err());
    }
}
