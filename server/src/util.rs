use serde_json::{json, Value};

pub fn config_json(value: Value) -> Value {
    json!({ "value": value })
}

pub fn unwrap_config_value(value: Option<Value>) -> Value {
    match value {
        Some(Value::Object(mut obj)) => obj.remove("value").unwrap_or(Value::Null),
        Some(value) => value,
        None => Value::Null,
    }
}
