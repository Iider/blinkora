use crate::app::AppState;
use crate::util::unwrap_config_value;
use anyhow::{anyhow, bail, Context};
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{Client, Method, StatusCode};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::Row;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub custom_path: String,
    pub force_path_style: bool,
}

impl S3Config {
    fn host_endpoint(&self) -> anyhow::Result<String> {
        let mut endpoint = self.endpoint.trim().trim_end_matches('/').to_string();
        if endpoint.is_empty() {
            bail!("Endpoint is required");
        }
        if !endpoint.contains("://") {
            endpoint = format!("https://{endpoint}");
        }
        Ok(endpoint)
    }
}

pub async fn load_s3_config(state: &AppState) -> anyhow::Result<Option<S3Config>> {
    let rows = sqlx::query(
        r#"SELECT key, config FROM config
           WHERE "userId" IS NULL
             AND key IN ('objectStorage','s3Endpoint','s3Region','s3Bucket','s3AccessKeyId','s3AccessKeySecret','s3SecretAccessKey','s3CustomPath','s3ForcePathStyle')"#,
    )
    .fetch_all(state.pool())
    .await?;

    let mut map = serde_json::Map::new();
    for row in rows {
        let key: String = row.get("key");
        let value: Option<Value> = row.get("config");
        map.insert(key, unwrap_config_value(value));
    }

    if map
        .get("objectStorage")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "s3"
    {
        return Ok(None);
    }

    let secret = read_string(&map, "s3AccessKeySecret")
        .or_else(|| read_string(&map, "s3SecretAccessKey"))
        .unwrap_or_default();

    Ok(Some(S3Config {
        endpoint: normalize_endpoint(read_string(&map, "s3Endpoint").unwrap_or_default())?,
        region: read_string(&map, "s3Region").unwrap_or_default(),
        bucket: read_string(&map, "s3Bucket").unwrap_or_default(),
        access_key_id: read_string(&map, "s3AccessKeyId").unwrap_or_default(),
        access_key_secret: secret,
        custom_path: normalize_custom_path(read_string(&map, "s3CustomPath").unwrap_or_default())?,
        force_path_style: read_bool(&map, "s3ForcePathStyle"),
    }))
}

pub fn normalize_custom_path(value: impl AsRef<str>) -> anyhow::Result<String> {
    let value = value.as_ref().trim().replace('\\', "/");
    if value.is_empty() {
        return Ok(String::new());
    }
    let parts = value
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.iter().any(|part| *part == "." || *part == "..") {
        bail!("Custom Path contains an invalid path segment");
    }
    if parts.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!("{}/", parts.join("/")))
    }
}

pub fn normalize_endpoint(value: impl AsRef<str>) -> anyhow::Result<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        bail!("Endpoint is required");
    }
    let normalized = if value.contains("://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let parsed =
        reqwest::Url::parse(&normalized).map_err(|_| anyhow!("Endpoint must be a valid URL"))?;
    let mut endpoint = parsed.to_string();
    if endpoint.ends_with('/') {
        endpoint.pop();
    }
    Ok(endpoint)
}

pub fn object_key(config: &S3Config, file_name: &str) -> String {
    format!(
        "{}{}",
        config.custom_path,
        file_name.trim_start_matches('/')
    )
}

pub async fn validate_config(config: &S3Config) -> anyhow::Result<(String, bool)> {
    validate_required(config)?;
    let attempts = if config.force_path_style {
        [true, false]
    } else {
        [false, true]
    };
    let key = object_key(
        config,
        &format!(
            ".blinkora-s3-validation-{}.txt",
            Utc::now().timestamp_millis()
        ),
    );
    let mut errors = Vec::new();
    for force_path_style in attempts {
        let mut next = config.clone();
        next.force_path_style = force_path_style;
        match async {
            put_object(
                &next,
                &key,
                b"blinkora s3 validation",
                "text/plain; charset=utf-8",
            )
            .await?;
            let _ = get_object(&next, &key).await?;
            delete_object(&next, &key).await?;
            anyhow::Ok(())
        }
        .await
        {
            Ok(()) => return Ok((key, force_path_style)),
            Err(err) => {
                let _ = delete_object(&next, &key).await;
                errors.push(format!(
                    "{}: {err}",
                    if force_path_style {
                        "path-style"
                    } else {
                        "virtual-hosted"
                    }
                ));
            }
        }
    }
    bail!("S3 validation failed. Tried {}", errors.join("; "));
}

pub async fn put_object(
    config: &S3Config,
    key: &str,
    body: &[u8],
    content_type: &str,
) -> anyhow::Result<()> {
    validate_required(config)?;
    let body_hash = hex::encode(Sha256::digest(body));
    let mut headers = vec![
        ("content-type".to_string(), content_type.to_string()),
        ("x-amz-content-sha256".to_string(), body_hash.clone()),
    ];
    let url = signed_url_and_headers(config, Method::PUT, key, "", &body_hash, &mut headers)?;
    let response = Client::new()
        .put(url)
        .headers(header_map(headers)?)
        .body(body.to_vec())
        .send()
        .await?;
    ensure_success(response.status(), "put object").await
}

pub async fn get_object(config: &S3Config, key: &str) -> anyhow::Result<Vec<u8>> {
    validate_required(config)?;
    let body_hash = "UNSIGNED-PAYLOAD".to_string();
    let mut headers = vec![("x-amz-content-sha256".to_string(), body_hash.clone())];
    let url = signed_url_and_headers(config, Method::GET, key, "", &body_hash, &mut headers)?;
    let response = Client::new()
        .get(url)
        .headers(header_map(headers)?)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        bail!("get object failed with HTTP {status}");
    }
    Ok(response.bytes().await?.to_vec())
}

pub async fn delete_object(config: &S3Config, key: &str) -> anyhow::Result<()> {
    validate_required(config)?;
    let body_hash = hex::encode(Sha256::digest([]));
    let mut headers = vec![("x-amz-content-sha256".to_string(), body_hash.clone())];
    let url = signed_url_and_headers(config, Method::DELETE, key, "", &body_hash, &mut headers)?;
    let response = Client::new()
        .delete(url)
        .headers(header_map(headers)?)
        .send()
        .await?;
    ensure_success(response.status(), "delete object").await
}

pub async fn copy_object(config: &S3Config, old_key: &str, new_key: &str) -> anyhow::Result<()> {
    validate_required(config)?;
    let body_hash = hex::encode(Sha256::digest([]));
    let copy_source = percent_encode_path(&format!("{}/{}", config.bucket, old_key));
    let mut headers = vec![
        ("x-amz-content-sha256".to_string(), body_hash.clone()),
        ("x-amz-copy-source".to_string(), copy_source),
    ];
    let url = signed_url_and_headers(config, Method::PUT, new_key, "", &body_hash, &mut headers)?;
    let response = Client::new()
        .put(url)
        .headers(header_map(headers)?)
        .send()
        .await?;
    ensure_success(response.status(), "copy object").await
}

fn signed_url_and_headers(
    config: &S3Config,
    method: Method,
    key: &str,
    query: &str,
    payload_hash: &str,
    headers: &mut Vec<(String, String)>,
) -> anyhow::Result<String> {
    let endpoint = config.host_endpoint()?;
    let (host, canonical_uri, url) = if config.force_path_style {
        let endpoint_url = endpoint.trim_end_matches('/');
        let host = endpoint_url
            .split("://")
            .nth(1)
            .ok_or_else(|| anyhow!("Endpoint must be a valid URL"))?
            .to_string();
        let uri = format!(
            "/{}/{}",
            percent_encode_segment(&config.bucket),
            percent_encode_key(key)
        );
        (host, uri.clone(), format!("{endpoint_url}{uri}"))
    } else {
        let endpoint_url = endpoint.trim_end_matches('/');
        let rest = endpoint_url
            .split("://")
            .nth(1)
            .ok_or_else(|| anyhow!("Endpoint must be a valid URL"))?;
        let scheme = endpoint_url
            .split("://")
            .next()
            .ok_or_else(|| anyhow!("Endpoint must be a valid URL"))?;
        let host = format!("{}.{}", config.bucket, rest);
        let uri = format!("/{}", percent_encode_key(key));
        (host.clone(), uri.clone(), format!("{scheme}://{host}{uri}"))
    };

    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    headers.push(("host".to_string(), host));
    headers.push(("x-amz-date".to_string(), amz_date.clone()));
    headers.sort_by(|left, right| left.0.cmp(&right.0));

    let signed_headers = headers
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = headers
        .iter()
        .map(|(key, value)| format!("{key}:{}\n", value.trim()))
        .collect::<String>();
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri,
        query,
        canonical_headers,
        signed_headers,
        payload_hash
    );
    let credential_scope = format!("{date}/{}/s3/aws4_request", config.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let signing_key = signing_key(&config.access_key_secret, &date, &config.region)?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let auth = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        config.access_key_id, credential_scope, signed_headers, signature
    );
    headers.push(("authorization".to_string(), auth));
    Ok(if query.is_empty() {
        url
    } else {
        format!("{url}?{query}")
    })
}

fn validate_required(config: &S3Config) -> anyhow::Result<()> {
    if config.endpoint.trim().is_empty() {
        bail!("Endpoint is required");
    }
    if config.region.trim().is_empty() {
        bail!("Region ID is required");
    }
    if config.bucket.trim().is_empty() {
        bail!("Bucket is required");
    }
    if config.access_key_id.trim().is_empty() {
        bail!("Access Key is required");
    }
    if config.access_key_secret.trim().is_empty() {
        bail!("Secret Key is required");
    }
    Ok(())
}

async fn ensure_success(status: StatusCode, action: &str) -> anyhow::Result<()> {
    if status.is_success() || status == StatusCode::NO_CONTENT {
        Ok(())
    } else {
        bail!("{action} failed with HTTP {status}");
    }
}

fn header_map(headers: Vec<(String, String)>) -> anyhow::Result<reqwest::header::HeaderMap> {
    let mut map = reqwest::header::HeaderMap::new();
    for (key, value) in headers {
        map.insert(
            reqwest::header::HeaderName::from_bytes(key.as_bytes())?,
            reqwest::header::HeaderValue::from_str(&value)?,
        );
    }
    Ok(map)
}

fn signing_key(secret: &str, date: &str, region: &str) -> anyhow::Result<Vec<u8>> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes())?;
    let k_region = hmac_sha256(&k_date, region.as_bytes())?;
    let k_service = hmac_sha256(&k_region, b"s3")?;
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key).context("invalid hmac key")?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn percent_encode_key(key: &str) -> String {
    key.split('/')
        .map(percent_encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_encode_path(path: &str) -> String {
    path.split('/')
        .map(percent_encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_encode_segment(segment: &str) -> String {
    urlencoding::encode(segment)
        .replace('+', "%20")
        .replace("%7E", "~")
}

fn read_string(map: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

fn read_bool(map: &serde_json::Map<String, Value>, key: &str) -> bool {
    match map.get(key) {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => value == "true",
        _ => false,
    }
}
