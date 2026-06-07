use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use futures::FutureExt;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("system.serverVersion", server_version);
    registry.insert("system.linkPreview", link_preview);
}

fn server_version(_ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move { Ok(json!("1.0.0-rust")) }.boxed()
}

fn link_preview(_ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let url = input.get("url").and_then(Value::as_str).unwrap_or("");
        let Ok(parsed) = reqwest::Url::parse(url) else {
            return Ok(empty_preview());
        };
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Ok(empty_preview());
        }
        if is_private_host(parsed.host_str().unwrap_or("")) {
            return Ok(empty_preview());
        }
        let resp = reqwest::Client::new()
            .get(parsed.clone())
            .header("User-Agent", "Blinkora-Server/1.0")
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
        let Ok(resp) = resp else {
            return Ok(empty_preview());
        };
        let html = resp.text().await.unwrap_or_default();
        let title = first_match(&html, r#"(?is)<title[^>]*>(.*?)</title>"#);
        let description = first_match(&html, r#"(?is)<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']"#)
            .or_else(|| first_match(&html, r#"(?is)<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']"#))
            .unwrap_or_default();
        let favicon = first_match(&html, r#"(?is)<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']*)["']"#)
            .and_then(|value| parsed.join(&value).ok().map(|u| u.to_string()))
            .unwrap_or_default();
        Ok(json!({
            "title": html_unescape(&title.unwrap_or_default()),
            "favicon": favicon,
            "description": html_unescape(&description)
        }))
    }
    .boxed()
}

fn empty_preview() -> Value {
    json!({ "title": "", "favicon": "", "description": "" })
}

fn is_private_host(host: &str) -> bool {
    host.parse::<IpAddr>()
        .map(|ip| match ip {
            IpAddr::V4(ip) => ip.is_loopback() || ip.is_private() || ip.is_unspecified(),
            IpAddr::V6(ip) => ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local(),
        })
        .unwrap_or(false)
}

fn first_match(html: &str, pattern: &str) -> Option<String> {
    Regex::new(pattern)
        .ok()?
        .captures(html)?
        .get(1)
        .map(|m| m.as_str().split_whitespace().collect::<Vec<_>>().join(" "))
}

fn html_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}
