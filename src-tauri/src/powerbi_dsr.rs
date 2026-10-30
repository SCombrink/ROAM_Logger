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
    let name_of = |k: &String| key_names.get(k).cloned().unwrap_or_else(|| k.clone());

    // A matrix with column groups (e.g. one column per month) lists those
    // column members under SH/DM1, and each row carries one "X" entry per
    // column member. Such matrices are flattened to one row per cell.
    let (col_columns, col_members) = ds["SH"]
        .as_array()
        .and_then(|sh| sh.iter().find_map(|h| h.get("DM1")))
        .and_then(|v| v.as_array())
        .map(|dm| decode_member_list(dm, &dicts))
        .unwrap_or_default();

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();

    for ph in ds["PH"].as_array().into_iter().flatten() {
        let Some(dm) = ph.get("DM0").and_then(|v| v.as_array()) else { continue };
        // Schema for the rows that follow: key, and optional value dictionary.
        let mut schema: Vec<(String, Option<String>)> = Vec::new();
        let mut prev: Vec<Value> = Vec::new();
        let mut x_schema: Vec<(String, Option<String>)> = Vec::new();
        for row in dm {
            if let Some(s) = row.get("S").and_then(|s| s.as_array()) {
                schema = parse_schema(s);
                prev = vec![Value::Null; schema.len()];
            }
            if schema.is_empty() {
                continue;
            }
            let decoded = decode_row(row, &schema, &prev, &dicts);
            prev = decoded.clone();

            match row.get("X").and_then(|x| x.as_array()) {
                Some(cells) if !col_members.is_empty() => {
                    let mut col_index: i64 = -1;
                    let mut x_prev: Vec<Value> = Vec::new();
                    for cell in cells {
                        if let Some(s) = cell.get("S").and_then(|s| s.as_array()) {
                            x_schema = parse_schema(s);
                        }
                        if x_schema.is_empty() {
                            continue;
                        }
                        if x_prev.len() != x_schema.len() {
                            x_prev = vec![Value::Null; x_schema.len()];
                        }
                        // "I" jumps to a column index; otherwise cells are consecutive.
                        col_index = cell.get("I").and_then(|i| i.as_i64()).unwrap_or(col_index + 1);
                        let Some(member) = col_members.get(col_index as usize) else { continue };
                        let values = decode_row(cell, &x_schema, &x_prev, &dicts);
                        x_prev = values.clone();
                        if columns.is_empty() {
                            columns = schema.iter().map(|(k, _)| name_of(k))
                                .chain(col_columns.iter().map(|k| name_of(k)))
                                .chain(x_schema.iter().map(|(k, _)| name_of(k)))
                                .collect();
                        }
                        rows.push(decoded.iter().chain(member.iter()).chain(values.iter()).cloned().collect());
                    }
                }
                _ => {
                    if columns.is_empty() {
                        columns = schema.iter().map(|(k, _)| name_of(k)).collect();
                    }
                    rows.push(decoded);
                }
            }
        }
    }

    if columns.is_empty() {
        return None;
    }
    Some(DecodedTable { columns, rows })
}

fn parse_schema(s: &[Value]) -> Vec<(String, Option<String>)> {
    s.iter()
        .filter_map(|c| Some((c["N"].as_str()?.to_string(), c["DN"].as_str().map(str::to_string))))
        .collect()
}

/// Decodes the column members of a matrix (SH/DM1): their keys and values.
fn decode_member_list(dm: &[Value], dicts: &Value) -> (Vec<String>, Vec<Vec<Value>>) {
    let mut schema: Vec<(String, Option<String>)> = Vec::new();
    let mut prev: Vec<Value> = Vec::new();
    let mut members = Vec::new();
    for m in dm {
        if let Some(s) = m.get("S").and_then(|s| s.as_array()) {
            schema = parse_schema(s);
            prev = vec![Value::Null; schema.len()];
        }
        if schema.is_empty() {
            continue;
        }
        let values = decode_row(m, &schema, &prev, dicts);
        prev = values.clone();
        members.push(values);
    }
    (schema.into_iter().map(|(k, _)| k).collect(), members)
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

/// The readable part of a column name: "Sum(Obs.January)" -> "January".
fn column_label(name: &str) -> String {
    let inner = match (name.find('('), name.rfind(')')) {
        (Some(open), Some(close)) if close > open => &name[open + 1..close],
        _ => name,
    };
    inner.rsplit('.').next().unwrap_or(inner).trim().to_string()
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
        let Some(oi) = find_column(&table.columns, observer_col) else { continue };
        let Some(di) = find_column(&table.columns, date_col) else {
            // Wide layout: one column per month, named e.g. "Sum(Obs.January)".
            let month_cols: Vec<(usize, String)> = table
                .columns
                .iter()
                .enumerate()
                .filter_map(|(i, c)| Some((i, month_key(&Value::from(column_label(c)), default_year)?)))
                .collect();
            if month_cols.len() < 2 {
                continue;
            }
            for row in &table.rows {
                let Some(observer) = row.get(oi).and_then(|v| v.as_str()).map(|s| s.trim().to_string()) else { continue };
                if observer.is_empty() {
                    continue;
                }
                let entry = out.entry(observer).or_default();
                for (ci, month) in &month_cols {
                    *entry.entry(month.clone()).or_insert(0.0) += row.get(*ci).and_then(as_count).unwrap_or(0.0);
                }
            }
            if !out.is_empty() {
                break;
            }
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

/// Adds a Power BI URL filter, e.g. `filter=Employees/Name eq 'Abbott, Ryan'`.
/// Single quotes in the value are doubled, as Power BI requires.
pub fn with_filter(url: &str, field: &str, value: &str) -> String {
    let expr = format!("{} eq '{}'", field.trim(), value.trim().replace('\'', "''"));
    let encoded: String = expr
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect();
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{}{}filter={}", url, sep, encoded)
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

    // A matrix: employees as rows, months as column groups (SH/DM1), counts in X cells.
    fn matrix_body() -> String {
        json!({
            "results": [{ "result": { "data": {
                "descriptor": { "Select": [
                    { "Kind": 1, "Value": "G0", "Name": "Employees.Personnel Number" },
                    { "Kind": 1, "Value": "G1", "Name": "Calendar.Month" },
                    { "Kind": 2, "Value": "M0", "Name": "Count(Observations.Id)" }
                ]},
                "dsr": { "DS": [{
                    "SH": [{ "DM1": [
                        { "S": [{ "N": "G1", "T": 1 }], "G1": "January" },
                        { "G1": "February" },
                        { "G1": "March" }
                    ]}],
                    "PH": [{ "DM0": [
                        { "S": [{ "N": "G0", "T": 1 }], "G0": "Abbott, Ryan",
                          "X": [{ "S": [{ "N": "M0", "T": 4 }], "M0": 2 }, { "M0": 5 }, { "M0": 1 }] },
                        { "G0": "Abbas, Jack", "X": [{ "M0": 3 }, { "I": 2, "M0": 4 }] }
                    ]}]
                }]}
            }}}]
        })
        .to_string()
    }

    #[test]
    fn decodes_matrix_column_groups() {
        let tables = decode_querydata(&matrix_body());
        assert_eq!(tables.len(), 1);
        let t = &tables[0];
        assert_eq!(t.columns, vec!["Employees.Personnel Number", "Calendar.Month", "Count(Observations.Id)"]);
        assert_eq!(t.rows.len(), 5);
        assert_eq!(t.rows[1], vec![json!("Abbott, Ryan"), json!("February"), json!(5)]);
        // "I": 2 skips February for Abbas
        assert_eq!(t.rows[4], vec![json!("Abbas, Jack"), json!("March"), json!(4)]);
        let counts = aggregate(&tables, "personnel number", "month", Some("count"), 2026);
        assert_eq!(counts["Abbott, Ryan"]["2026-02"], 5.0);
        assert_eq!(counts["Abbas, Jack"]["2026-01"], 3.0);
        assert_eq!(counts["Abbas, Jack"].get("2026-02"), None);
        assert_eq!(counts["Abbas, Jack"]["2026-03"], 4.0);
    }

    #[test]
    fn reads_wide_month_columns() {
        let tables = vec![DecodedTable {
            columns: vec!["Employees.Personnel Number".into(), "Employees.Office".into(), "Sum(Obs.January)".into(), "Sum(Obs.February)".into(), "Sum(Obs.March)".into()],
            rows: vec![vec![json!("Abbott, Ryan"), json!("Houston"), json!(1), json!(4), Value::Null]],
        }];
        let counts = aggregate(&tables, "personnel number", "no such column", None, 2026);
        assert_eq!(counts["Abbott, Ryan"]["2026-01"], 1.0);
        assert_eq!(counts["Abbott, Ryan"]["2026-02"], 4.0);
        assert_eq!(counts["Abbott, Ryan"]["2026-03"], 0.0);
        assert_eq!(column_label("Sum(Obs.January)"), "January");
    }

    #[test]
    fn builds_url_filter() {
        assert_eq!(
            with_filter("https://app.powerbi.com/groups/me/reports/r/ReportSection1?experience=power-bi", "Employees/Personnel_x0020_Number", "O'Neil, Pat"),
            "https://app.powerbi.com/groups/me/reports/r/ReportSection1?experience=power-bi&filter=Employees/Personnel_x0020_Number%20eq%20%27O%27%27Neil%2C%20Pat%27"
        );
        assert!(with_filter("https://x/report", "T/C", "A").ends_with("/report?filter=T/C%20eq%20%27A%27"));
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
