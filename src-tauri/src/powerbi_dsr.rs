// Pure parsing for Power BI "querydata" responses: decoding the compressed
// DSR format into tables, and turning tables into monthly counts. Kept free of
// Tauri and Edge code so it can be unit tested on its own.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// One visual's data, decoded from a querydata response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DecodedTable {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

// ---------------------------------------------------------------------------
// DSR decoding
// ---------------------------------------------------------------------------

/// Decodes every visual result in a querydata response body.
pub fn decode_querydata(body: &str) -> Vec<DecodedTable> {
    let root: Value = match serde_json::from_str(body.trim_start_matches('\u{FEFF}')) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut tables = Vec::new();
    for result in root.get("results").and_then(|r| r.as_array()).into_iter().flatten() {
        let data = &result["result"]["data"];
        if let Some(table) = decode_result(data) {
            tables.push(table);
        }
    }
    tables
}

fn decode_result(data: &Value) -> Option<DecodedTable> {
    // descriptor.Select maps the short keys used in the data (G0, M0, ...)
    // to readable names such as "Observations.Observer" or "Count(Observations.Id)".
    let mut key_names: BTreeMap<String, String> = BTreeMap::new();
    for sel in data["descriptor"]["Select"].as_array().into_iter().flatten() {
        if let Some(key) = sel["Value"].as_str() {
            let name = sel["Name"].as_str().map(str::to_string).unwrap_or_else(|| key.to_string());
            key_names.insert(key.to_string(), name);
        }
    }

    let ds = data["dsr"]["DS"].as_array()?.first()?;
    let dicts = ds.get("ValueDicts").cloned().unwrap_or(Value::Null);

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();

    for ph in ds["PH"].as_array().into_iter().flatten() {
        // Only the primary row hierarchy (DM0) is read; matrix column
        // hierarchies (DM1+) are not needed for a list or simple chart.
        let Some(dm) = ph.get("DM0").and_then(|v| v.as_array()) else { continue };
        // Schema for the rows that follow: key, and optional value dictionary.
        let mut schema: Vec<(String, Option<String>)> = Vec::new();
        let mut prev: Vec<Value> = Vec::new();
        for row in dm {
            if let Some(s) = row.get("S").and_then(|s| s.as_array()) {
                schema = s
                    .iter()
                    .filter_map(|c| Some((c["N"].as_str()?.to_string(), c["DN"].as_str().map(str::to_string))))
                    .collect();
                prev = vec![Value::Null; schema.len()];
                if columns.is_empty() {
                    columns = schema.iter().map(|(k, _)| key_names.get(k).cloned().unwrap_or_else(|| k.clone())).collect();
                }
            }
            if schema.is_empty() {
                continue;
            }
            let decoded = decode_row(row, &schema, &prev, &dicts);
            prev = decoded.clone();
            rows.push(decoded);
        }
    }

    if columns.is_empty() {
        return None;
    }
    Some(DecodedTable { columns, rows })
}

/// Expands one compressed DSR row. "C" holds only the values that are not
/// repeated ("R" bitmask, copy from previous row) or null ("Ø" bitmask).
/// Columns with a value dictionary store an index into ValueDicts.
fn decode_row(row: &Value, schema: &[(String, Option<String>)], prev: &[Value], dicts: &Value) -> Vec<Value> {
    let repeat = row.get("R").and_then(|v| v.as_u64()).unwrap_or(0);
    let nulls = row.get("Ø").and_then(|v| v.as_u64()).unwrap_or(0);
    let compressed: Vec<Value> = row.get("C").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut next = compressed.into_iter();

    schema
        .iter()
        .enumerate()
        .map(|(i, (key, dict))| {
            let bit = 1u64 << i;
            if repeat & bit != 0 {
                return prev.get(i).cloned().unwrap_or(Value::Null);
            }
            if nulls & bit != 0 {
                return Value::Null;
            }
            // Single-value rows sometimes carry the value under its key instead of "C".
            let raw = match row.get(key) {
                Some(v) if row.get("C").is_none() => v.clone(),
                _ => next.next().unwrap_or(Value::Null),
            };
            match (dict, raw.as_u64()) {
                (Some(d), Some(idx)) => dicts[d.as_str()][idx as usize].clone(),
                _ => raw,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Turning tables into monthly counts
// ---------------------------------------------------------------------------

/// Finds the column whose name contains `wanted` (case-insensitive).
fn find_column(columns: &[String], wanted: &str) -> Option<usize> {
    let wanted = wanted.to_lowercase();
    columns.iter().position(|c| c.to_lowercase().contains(&wanted))
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// Normalises a date-ish value to "YYYY-MM". Handles epoch milliseconds,
/// ISO dates, "YYYY-MM", and month names ("Oct", "October 2026").
pub fn month_key(value: &Value, default_year: i32) -> Option<String> {
    if let Some(ms) = value.as_f64() {
        if ms > 1e11 {
            let dt = chrono::DateTime::from_timestamp_millis(ms as i64)?;
            return Some(dt.format("%Y-%m").to_string());
        }
        return None;
    }
    let s = value.as_str()?.trim();
    let bytes = s.as_bytes();
    if s.len() >= 7 && bytes[4] == b'-' && s[..4].chars().all(|c| c.is_ascii_digit()) && s[5..7].chars().all(|c| c.is_ascii_digit()) {
        return Some(s[..7].to_string());
    }
    // "/Date(1730419200000)/" style
    if let Some(inner) = s.strip_prefix("/Date(").and_then(|r| r.strip_suffix(")/")) {
        return month_key(&Value::from(inner.parse::<f64>().ok()?), default_year);
    }
    let lower = s.to_lowercase();
    let month = MONTHS.iter().position(|m| lower.starts_with(m))?;
    let year = lower
        .split(|c: char| !c.is_ascii_digit())
        .find(|p| p.len() == 4)
        .and_then(|p| p.parse::<i32>().ok())
        .unwrap_or(default_year);
    Some(format!("{:04}-{:02}", year, month + 1))
}

fn as_count(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str().and_then(|s| s.replace(',', "").trim().parse::<f64>().ok()))
}

/// Sums counts per observer per month across every table that has the
/// configured observer and date columns. Rows without a count column count as 1.
pub fn aggregate(
    tables: &[DecodedTable],
    observer_col: &str,
    date_col: &str,
    count_col: Option<&str>,
    default_year: i32,
) -> BTreeMap<String, BTreeMap<String, f64>> {
    let mut out: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    // The same visual is often fetched more than once (e.g. on resize); skip duplicates.
    let mut seen: Vec<&DecodedTable> = Vec::new();
    for table in tables {
        if seen.contains(&table) {
            continue;
        }
        seen.push(table);
        let (Some(oi), Some(di)) = (find_column(&table.columns, observer_col), find_column(&table.columns, date_col)) else {
            continue;
        };
        let ci = count_col.and_then(|c| find_column(&table.columns, c));
        for row in &table.rows {
            let Some(observer) = row.get(oi).and_then(|v| v.as_str()).map(|s| s.trim().to_string()) else { continue };
            if observer.is_empty() {
                continue;
            }
            let Some(month) = row.get(di).and_then(|v| month_key(v, default_year)) else { continue };
            let n = match ci {
                Some(ci) => row.get(ci).and_then(as_count).unwrap_or(0.0),
                None => 1.0,
            };
            *out.entry(observer).or_default().entry(month).or_insert(0.0) += n;
        }
        // Only the first matching visual is used, so two visuals showing the
        // same data are not double counted.
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// Decodes a base64 response body (CDP returns binary bodies this way).
pub fn base64_decode(input: &str) -> Option<String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for c in input.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=') {
        let v = TABLE.iter().position(|t| *t == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A querydata response in Power BI's DSR shape: a dictionary-encoded
    // observer column, epoch-ms dates, a count measure, and R / Ø bitmasks.
    fn sample_body() -> String {
        json!({
            "jobIds": ["x"],
            "results": [{
                "jobId": "x",
                "result": { "data": {
                    "descriptor": { "Select": [
                        { "Kind": 1, "Value": "G0", "Name": "Observations.Observer Name" },
                        { "Kind": 1, "Value": "G1", "Name": "Observations.Observation Date" },
                        { "Kind": 2, "Value": "M0", "Name": "CountNonNull(Observations.Id)" }
                    ]},
                    "dsr": { "Version": 2, "MinorVersion": 1, "DS": [{
                        "N": "DS0",
                        "PH": [{ "DM0": [
                            { "S": [{ "N": "G0", "T": 1, "DN": "D0" }, { "N": "G1", "T": 7 }, { "N": "M0", "T": 4 }],
                              "C": [0, 1767225600000_i64, 2] },
                            { "C": [1772323200000_i64, 1], "R": 1 },
                            { "C": [1, 1767225600000_i64, 3] },
                            { "C": [2, 1767225600000_i64], "Ø": 4 }
                        ]}],
                        "ValueDicts": { "D0": ["Jane Doe", "Sam Lee", "Alex Kim"] }
                    }]}
                }}
            }]
        })
        .to_string()
    }

    #[test]
    fn decodes_dsr_rows() {
        let tables = decode_querydata(&sample_body());
        assert_eq!(tables.len(), 1);
        let t = &tables[0];
        assert_eq!(t.columns, vec!["Observations.Observer Name", "Observations.Observation Date", "CountNonNull(Observations.Id)"]);
        assert_eq!(t.rows.len(), 4);
        assert_eq!(t.rows[0], vec![json!("Jane Doe"), json!(1767225600000_i64), json!(2)]);
        // R bit 0 repeats the observer from the previous row
        assert_eq!(t.rows[1], vec![json!("Jane Doe"), json!(1772323200000_i64), json!(1)]);
        assert_eq!(t.rows[2][0], json!("Sam Lee"));
        // Ø bit 2 makes the count null
        assert_eq!(t.rows[3], vec![json!("Alex Kim"), json!(1767225600000_i64), Value::Null]);
    }

    #[test]
    fn aggregates_counts_per_month() {
        let tables = decode_querydata(&sample_body());
        let counts = aggregate(&tables, "observer", "date", Some("count"), 2026);
        assert_eq!(counts["Jane Doe"]["2026-01"], 2.0);
        assert_eq!(counts["Jane Doe"]["2026-03"], 1.0);
        assert_eq!(counts["Sam Lee"]["2026-01"], 3.0);
        assert_eq!(counts["Alex Kim"]["2026-01"], 0.0);
    }

    #[test]
    fn counts_rows_when_no_count_column() {
        let tables = decode_querydata(&sample_body());
        let counts = aggregate(&tables, "observer", "date", None, 2026);
        assert_eq!(counts["Sam Lee"]["2026-01"], 1.0);
    }

    #[test]
    fn duplicate_visual_results_are_not_double_counted() {
        let mut tables = decode_querydata(&sample_body());
        tables.extend(decode_querydata(&sample_body()));
        let counts = aggregate(&tables, "observer", "date", Some("count"), 2026);
        assert_eq!(counts["Jane Doe"]["2026-01"], 2.0);
    }

    #[test]
    fn month_keys() {
        assert_eq!(month_key(&json!("2026-10-03T00:00:00"), 2026).as_deref(), Some("2026-10"));
        assert_eq!(month_key(&json!("2026-04"), 2026).as_deref(), Some("2026-04"));
        assert_eq!(month_key(&json!("October"), 2026).as_deref(), Some("2026-10"));
        assert_eq!(month_key(&json!("Sep 2025"), 2026).as_deref(), Some("2025-09"));
        assert_eq!(month_key(&json!("/Date(1767225600000)/"), 2026).as_deref(), Some("2026-01"));
        assert_eq!(month_key(&json!(1767225600000_i64), 2026).as_deref(), Some("2026-01"));
        assert_eq!(month_key(&json!("Total"), 2026), None);
    }

    #[test]
    fn base64_round_trip() {
        assert_eq!(base64_decode("eyJhIjoxfQ==").as_deref(), Some("{\"a\":1}"));
    }
}
