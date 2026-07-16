use anyhow::{bail, Result};
use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: String,
    pub port: String,
    pub auth_secret: String,
    pub node_env: String,
    pub data_dir: String,
}

impl Config {
    pub fn from_env() -> Self {
        let node_env = env_var("NODE_ENV", "development");
        let mut auth_secret = env_var("BLINKORA_SECRET", "");
        if auth_secret.is_empty() && node_env != "production" {
            auth_secret = "dev-only-insecure-secret".to_string();
        }
        Self {
            bind_addr: env_var("BIND_ADDR", "127.0.0.1"),
            port: env_var("PORT", "6676"),
            auth_secret,
            node_env,
            data_dir: env_var("DATA_DIR", "./data"),
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
            bind_addr: "0.0.0.0".into(),
            port: "6676".into(),
            auth_secret: "dev-only-insecure-secret".into(),
            node_env: "production".into(),
            data_dir: "./data".into(),
        };
        assert!(cfg.validate().is_err());
    }
}
