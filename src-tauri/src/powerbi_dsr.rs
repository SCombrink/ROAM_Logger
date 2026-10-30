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
    /// True for columns that are measures (counts, sums) rather than fields.
    #[serde(default)]
    pub measures: Vec<bool>,
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
    let mut measure_keys: Vec<String> = Vec::new();
    for sel in data["descriptor"]["Select"].as_array().into_iter().flatten() {
        if let Some(key) = sel["Value"].as_str() {
            let name = sel["Name"].as_str().map(str::to_string).unwrap_or_else(|| key.to_string());
            key_names.insert(key.to_string(), name);
            // Kind 2 = measure (an aggregated value); Kind 1 = a grouping field.
            if sel["Kind"].as_u64() == Some(2) {
                measure_keys.push(key.to_string());
            }
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

    let mut column_keys: Vec<String> = Vec::new();
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
                        if column_keys.is_empty() {
                            column_keys = schema.iter().map(|(k, _)| k.clone())
                                .chain(col_columns.iter().cloned())
                                .chain(x_schema.iter().map(|(k, _)| k.clone()))
                                .collect();
                        }
                        rows.push(decoded.iter().chain(member.iter()).chain(values.iter()).cloned().collect());
                    }
                }
                _ => {
                    if column_keys.is_empty() {
                        column_keys = schema.iter().map(|(k, _)| k.clone()).collect();
                    }
                    rows.push(decoded);
                }
            }
        }
    }

    if column_keys.is_empty() {
        return None;
    }
    Some(DecodedTable {
        columns: column_keys.iter().map(name_of).collect(),
        measures: column_keys.iter().map(|k| measure_keys.contains(k)).collect(),
        rows,
    })
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

/// Optional column names from the config. Anything left unset is detected
/// from the data, so the report can be read without manual setup.
#[derive(Debug, Clone, Default)]
pub struct ColumnHints {
    pub observer: Option<String>,
    pub date: Option<String>,
    pub count: Option<String>,
    /// Rolling layout: the last `n` count columns are the last `n` months,
    /// the right-most being `end` (year, month 1-12). Their names are ignored.
    pub rolling: Option<(usize, (i32, u32))>,
}

/// "YYYY-MM" for `back` months before (year, month).
fn months_before((year, month): (i32, u32), back: usize) -> String {
    let index = year as i64 * 12 + (month as i64 - 1) - back as i64;
    format!("{:04}-{:02}", index.div_euclid(12), index.rem_euclid(12) + 1)
}

/// The columns holding the rolling months, left to right: the last `n`
/// measure columns (or the last `n` columns of a table read as text).
fn rolling_columns(table: &DecodedTable, n: usize) -> Option<Vec<usize>> {
    let has_measures = table.measures.iter().any(|m| *m);
    let cols: Vec<usize> = (0..table.columns.len())
        .filter(|i| !has_measures || table.measures.get(*i).copied().unwrap_or(false))
        .collect();
    (cols.len() >= n).then(|| cols[cols.len() - n..].to_vec())
}

/// The calendar month (1-12) named in a column label, ignoring any digits:
/// "ObsCountNov21" -> 11, "23Feb" -> 2, "Sept2023" -> 9, "January" -> 1.
pub fn named_month(label: &str) -> Option<u32> {
    const FULL: [&str; 12] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    let l = label.to_lowercase();
    if let Some(i) = FULL.iter().position(|m| l.contains(m)) {
        return Some(i as u32 + 1);
    }
    if l.contains("sept") {
        return Some(9);
    }
    MONTHS.iter().position(|m| l.contains(m)).map(|i| i as u32 + 1)
}

/// The month of each rolling column, left to right. Preferably from the month
/// named in each column (the year digits in those names are stale), dated to
/// the most recent such month on or before `end`. If any column has no month
/// name, or two share one, falls back to position: the right-most column is
/// `end` and each column to its left one month earlier.
pub fn rolling_months(table: &DecodedTable, cols: &[usize], end: (i32, u32)) -> (Vec<String>, bool) {
    let named: Vec<Option<u32>> = cols.iter().map(|c| named_month(&column_label(&table.columns[*c]))).collect();
    let distinct: std::collections::BTreeSet<u32> = named.iter().flatten().copied().collect();
    if named.iter().all(Option::is_some) && distinct.len() == cols.len() {
        let months = named
            .iter()
            .map(|m| {
                let m = m.unwrap();
                let year = if m <= end.1 { end.0 } else { end.0 - 1 };
                format!("{:04}-{:02}", year, m)
            })
            .collect();
        return (months, true);
    }
    let n = cols.len();
    ((0..n).map(|k| months_before(end, n - 1 - k)).collect(), false)
}

/// Power BI stamps each response with the server time ("/Date(ms)/").
/// Returns the latest stamp across responses, in milliseconds.
pub fn data_timestamp(bodies: &[String]) -> Option<i64> {
    bodies
        .iter()
        .filter_map(|b| serde_json::from_str::<Value>(b.trim_start_matches('\u{FEFF}')).ok())
        .flat_map(|root| {
            root["results"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|r| {
                    let t = r["result"]["data"]["timestamp"].as_str()?.to_string();
                    t.strip_prefix("/Date(")?.strip_suffix(")/")?.parse::<i64>().ok()
                })
                .collect::<Vec<_>>()
        })
        .max()
}

/// Cross-check against a list of observation dates, if the report sent one:
/// a month cannot have more days with observations than observations.
/// Returns a note per month that disagrees (empty = consistent).
pub fn check_against_dates(tables: &[DecodedTable], months: &BTreeMap<String, f64>) -> Vec<String> {
    let mut days: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
    for t in tables {
        if t.columns.len() != 1 || t.measures.first() == Some(&true) || !t.columns[0].to_lowercase().contains("date") {
            continue;
        }
        for row in &t.rows {
            if let Some(ms) = row.first().and_then(|v| v.as_f64()).filter(|ms| *ms > 1e11) {
                if let Some(d) = chrono::DateTime::from_timestamp_millis(ms as i64) {
                    days.entry(d.format("%Y-%m").to_string()).or_default().insert(d.format("%Y-%m-%d").to_string());
                }
            }
        }
    }
    days.iter()
        .filter(|(m, d)| months.contains_key(*m) && (d.len() as f64) > months[*m])
        .map(|(m, d)| format!("{}: {} days with observations but a count of {}", m, d.len(), months[m]))
        .collect()
}

/// Finds the column whose name contains `wanted` (case-insensitive).
fn find_column(columns: &[String], wanted: &str) -> Option<usize> {
    let wanted = wanted.to_lowercase();
    columns.iter().position(|c| c.to_lowercase().contains(&wanted))
}

/// The readable part of a column name: "Sum(Obs.January)" -> "January".
pub fn column_label(name: &str) -> String {
    let inner = match (name.find('('), name.rfind(')')) {
        (Some(open), Some(close)) if close > open => &name[open + 1..close],
        _ => name,
    };
    inner.rsplit('.').next().unwrap_or(inner).trim().to_string()
}

/// "Abbott, Ryan" style: exactly one comma with text on both sides.
fn looks_like_person(value: &Value) -> bool {
    let Some(s) = value.as_str() else { return false };
    let mut parts = s.split(',');
    matches!((parts.next(), parts.next(), parts.next()), (Some(a), Some(b), None) if !a.trim().is_empty() && !b.trim().is_empty() && !b.trim().chars().all(|c| c.is_ascii_digit()))
}

/// The column holding employee names: the configured one, or else the
/// column where most values look like "Last, First".
pub fn observer_column(table: &DecodedTable, hint: Option<&str>) -> Option<usize> {
    if let Some(h) = hint {
        return find_column(&table.columns, h);
    }
    let sample: Vec<&Vec<Value>> = table.rows.iter().take(200).collect();
    if sample.is_empty() {
        return None;
    }
    (0..table.columns.len())
        .filter(|i| !table.measures.get(*i).copied().unwrap_or(false))
        .map(|i| (i, sample.iter().filter(|r| r.get(i).map(looks_like_person).unwrap_or(false)).count()))
        .filter(|(_, n)| *n * 10 >= sample.len() * 8)
        .max_by_key(|(_, n)| *n)
        .map(|(i, _)| i)
}

/// Where the month comes from in a table.
enum MonthSource {
    /// One column holds the month or date of each row.
    Column(usize),
    /// One column per month (wide table).
    Wide(Vec<(usize, String)>),
}

/// Dates that are about the employee rather than the observation.
fn is_employee_date(name: &str) -> bool {
    let n = name.to_lowercase();
    ["hire", "birth", "start", "end", "termination", "leave"].iter().any(|w| n.contains(w))
}

fn month_source(table: &DecodedTable, hint: Option<&str>, observer: usize, default_year: i32) -> Option<MonthSource> {
    if let Some(h) = hint {
        return find_column(&table.columns, h).map(MonthSource::Column);
    }
    // One column per month, e.g. "Sum(Obs.January)" ... "Sum(Obs.December)".
    let wide: Vec<(usize, String)> = table
        .columns
        .iter()
        .enumerate()
        .filter_map(|(i, c)| Some((i, month_key(&Value::from(column_label(c)), default_year)?)))
        .collect();
    if wide.len() >= 2 {
        return Some(MonthSource::Wide(wide));
    }
    // Otherwise a field whose values are months or dates, preferring one
    // named "month", and never the hire date.
    let candidates: Vec<usize> = (0..table.columns.len())
        .filter(|i| *i != observer && !table.measures.get(*i).copied().unwrap_or(false) && !is_employee_date(&table.columns[*i]))
        .filter(|i| {
            let vals: Vec<&Value> = table.rows.iter().take(50).filter_map(|r| r.get(*i)).filter(|v| !v.is_null()).collect();
            !vals.is_empty() && vals.iter().all(|v| month_key(v, default_year).is_some())
        })
        .collect();
    candidates
        .iter()
        .find(|i| table.columns[**i].to_lowercase().contains("month"))
        .or_else(|| candidates.first())
        .map(|i| MonthSource::Column(*i))
}

/// The count column: configured, or the measure (preferring one named like a count).
fn count_column(table: &DecodedTable, hint: Option<&str>) -> Option<usize> {
    if let Some(h) = hint {
        return find_column(&table.columns, h);
    }
    let measures: Vec<usize> = (0..table.columns.len()).filter(|i| table.measures.get(*i).copied().unwrap_or(false)).collect();
    measures
        .iter()
        .find(|i| {
            let n = table.columns[**i].to_lowercase();
            n.contains("count") || n.contains("obs")
        })
        .or_else(|| measures.first())
        .copied()
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
    // Reject words that merely start like a month ("Market", "Junior").
    let word: String = lower.chars().take_while(|c| c.is_alphabetic()).collect();
    const FULL: [&str; 12] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    if !(word.len() == 3 || FULL[month] == word || (month == 8 && word == "sept")) {
        return None;
    }
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

fn person(row: &[Value], i: usize) -> Option<String> {
    let name = row.get(i)?.as_str()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Sums counts per observer per month. Uses the first visual that has an
/// observer column and months, so two visuals showing the same data are not
/// double counted. Rows without a count column count as 1.
pub fn aggregate(tables: &[DecodedTable], hints: &ColumnHints, default_year: i32) -> BTreeMap<String, BTreeMap<String, f64>> {
    let mut out: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    for table in tables {
        let Some(oi) = observer_column(table, hints.observer.as_deref()) else { continue };
        let source = match hints.rolling {
            Some((n, end)) => match rolling_columns(table, n) {
                Some(cols) => {
                    let (months, _by_name) = rolling_months(table, &cols, end);
                    MonthSource::Wide(cols.iter().copied().zip(months).collect())
                }
                None => continue,
            },
            None => match month_source(table, hints.date.as_deref(), oi, default_year) {
                Some(s) => s,
                None => continue,
            },
        };
        match source {
            MonthSource::Wide(month_cols) => {
                for row in &table.rows {
                    let Some(observer) = person(row, oi) else { continue };
                    let entry = out.entry(observer).or_default();
                    for (ci, month) in &month_cols {
                        *entry.entry(month.clone()).or_insert(0.0) += row.get(*ci).and_then(as_count).unwrap_or(0.0);
                    }
                }
            }
            MonthSource::Column(di) => {
                let ci = count_column(table, hints.count.as_deref());
                for row in &table.rows {
                    let Some(observer) = person(row, oi) else { continue };
                    let Some(month) = row.get(di).and_then(|v| month_key(v, default_year)) else { continue };
                    let n = match ci {
                        Some(ci) => row.get(ci).and_then(as_count).unwrap_or(0.0),
                        None => 1.0,
                    };
                    *out.entry(observer).or_default().entry(month).or_insert(0.0) += n;
                }
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// Every employee name seen in the report, for the name search.
pub fn names_in(tables: &[DecodedTable], hint: Option<&str>) -> Vec<String> {
    let mut names = std::collections::BTreeSet::new();
    for table in tables {
        if let Some(oi) = observer_column(table, hint) {
            names.extend(table.rows.iter().filter_map(|r| person(r, oi)));
        }
    }
    names.into_iter().collect()
}

/// The full query name of the observer column ("Employees.Personnel Number"),
/// used to build URL filters.
pub fn observer_query_name(tables: &[DecodedTable], hint: Option<&str>) -> Option<String> {
    tables.iter().find_map(|t| observer_column(t, hint).map(|i| t.columns[i].clone()))
}

/// Converts "Employees.Personnel Number" to Power BI's URL filter form
/// "Employees/Personnel_x0020_Number" (special characters become _xHHHH_).
pub fn url_filter_field(query_name: &str) -> Option<String> {
    let (table, column) = query_name.split_once('.')?;
    let escape = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c.to_string() } else { format!("_x{:04X}_", c as u32) })
            .collect()
    };
    Some(format!("{}/{}", escape(table.trim()), escape(column.trim())))
}

fn quote(value: &str) -> String {
    format!("'{}'", value.trim().replace('\'', "''"))
}

/// `Field eq 'A'`, or `Field in ('A','B')` for several candidate names.
pub fn filter_any_of(field: &str, values: &[String]) -> String {
    match values {
        [one] => format!("{} eq {}", field, quote(one)),
        _ => format!("{} in ({})", field, values.iter().map(|v| quote(v)).collect::<Vec<_>>().join(",")),
    }
}

/// `contains(Field,'abb')` for the name search.
pub fn filter_contains(field: &str, text: &str) -> String {
    format!("contains({},{})", field, quote(text))
}

/// Appends a Power BI URL filter expression to the report URL.
pub fn with_filter(url: &str, expr: &str) -> String {
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

/// Report-style names ("Last, First") for a signed-in user.
pub fn name_candidates(given: Option<&str>, family: Option<&str>, display: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if !s.is_empty() && !out.iter().any(|o| o.eq_ignore_ascii_case(&s)) {
            out.push(s);
        }
    };
    if let (Some(g), Some(f)) = (given.map(str::trim).filter(|s| !s.is_empty()), family.map(str::trim).filter(|s| !s.is_empty())) {
        push(format!("{}, {}", f, g));
    }
    if let Some(d) = display.map(str::trim).filter(|s| !s.is_empty()) {
        if d.contains(',') {
            // Some directories add a suffix: "Abbott, Ryan (Hatch)".
            push(d.split('(').next().unwrap_or(d).trim().to_string());
        } else if let Some((first, last)) = d.split_once(' ') {
            push(format!("{}, {}", last, first));
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
        let counts = aggregate(&tables, &hints(Some("observer"), Some("date"), Some("count")), 2026);
        assert_eq!(counts["Jane Doe"]["2026-01"], 2.0);
        assert_eq!(counts["Jane Doe"]["2026-03"], 1.0);
        assert_eq!(counts["Sam Lee"]["2026-01"], 3.0);
        assert_eq!(counts["Alex Kim"]["2026-01"], 0.0);
    }

    fn hints(o: Option<&str>, d: Option<&str>, c: Option<&str>) -> ColumnHints {
        ColumnHints { observer: o.map(Into::into), date: d.map(Into::into), count: c.map(Into::into), rolling: None }
    }

    #[test]
    fn counts_rows_when_no_count_column() {
        let tables = decode_querydata(&sample_body());
        let counts = aggregate(&tables, &hints(Some("observer"), Some("date"), Some("no such column")), 2026);
        assert_eq!(counts["Sam Lee"]["2026-01"], 1.0);
    }

    #[test]
    fn duplicate_visual_results_are_not_double_counted() {
        let mut tables = decode_querydata(&sample_body());
        tables.extend(decode_querydata(&sample_body()));
        let counts = aggregate(&tables, &hints(Some("observer"), Some("date"), Some("count")), 2026);
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
        let counts = aggregate(&tables, &hints(Some("personnel number"), Some("month"), Some("count")), 2026);
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
            measures: vec![false, false, true, true, true],
        }];
        let counts = aggregate(&tables, &ColumnHints::default(), 2026);
        assert_eq!(counts["Abbott, Ryan"]["2026-01"], 1.0);
        assert_eq!(counts["Abbott, Ryan"]["2026-02"], 4.0);
        assert_eq!(counts["Abbott, Ryan"]["2026-03"], 0.0);
        assert_eq!(column_label("Sum(Obs.January)"), "January");
    }

    #[test]
    fn builds_url_filters() {
        let field = url_filter_field("Employees.Personnel Number").unwrap();
        assert_eq!(field, "Employees/Personnel_x0020_Number");
        assert_eq!(url_filter_field("Emp Data.Name (Full)").unwrap(), "Emp_x0020_Data/Name_x0020__x0028_Full_x0029_");
        assert_eq!(
            with_filter("https://app.powerbi.com/r/ReportSection1?experience=power-bi", &filter_any_of(&field, &["O'Neil, Pat".to_string()])),
            "https://app.powerbi.com/r/ReportSection1?experience=power-bi&filter=Employees/Personnel_x0020_Number%20eq%20%27O%27%27Neil%2C%20Pat%27"
        );
        assert_eq!(filter_any_of("T/C", &["A".into(), "B".into()]), "T/C in ('A','B')");
        assert_eq!(filter_contains("T/C", "abb"), "contains(T/C,'abb')");
        assert!(with_filter("https://x/report", "T/C eq 'A'").ends_with("/report?filter=T/C%20eq%20%27A%27"));
    }

    // The real report layout: employee details as row fields (including a
    // hire date that must be ignored), months as matrix column groups, and an
    // observation count measure. No column hints, so everything is detected.
    fn report_like_body() -> String {
        json!({
            "results": [{ "result": { "data": {
                "descriptor": { "Select": [
                    { "Kind": 1, "Value": "G0", "Name": "Employees.Pers.no." },
                    { "Kind": 1, "Value": "G1", "Name": "Employees.Personnel Number" },
                    { "Kind": 1, "Value": "G2", "Name": "Employees.Hire Date" },
                    { "Kind": 1, "Value": "G3", "Name": "Employees.Office" },
                    { "Kind": 1, "Value": "G4", "Name": "Date.Month" },
                    { "Kind": 2, "Value": "M0", "Name": "Observations.Observation Count" }
                ]},
                "dsr": { "DS": [{
                    "SH": [{ "DM1": [
                        { "S": [{ "N": "G4", "T": 1 }], "G4": "Jan 2026" },
                        { "G4": "Feb 2026" },
                        { "G4": "Mar 2026" }
                    ]}],
                    "PH": [{ "DM0": [
                        { "S": [{ "N": "G0", "T": 4 }, { "N": "G1", "T": 1 }, { "N": "G2", "T": 7 }, { "N": "G3", "T": 1 }],
                          "C": [237126, "Abbott, Ryan", 1783296000000_i64, "Houston"],
                          "X": [{ "S": [{ "N": "M0", "T": 4 }], "M0": 1 }, { "M0": 4 }, { "M0": 2 }] },
                        { "C": [15112, "Abbas, Jack", 1776643200000_i64, "Mississauga"], "X": [{ "I": 1, "M0": 6 }] }
                    ]}]
                }]}
            }}}]
        })
        .to_string()
    }

    #[test]
    fn detects_columns_without_config() {
        let tables = decode_querydata(&report_like_body());
        assert_eq!(tables[0].measures, vec![false, false, false, false, false, true]);
        let counts = aggregate(&tables, &ColumnHints::default(), 2026);
        assert_eq!(counts.len(), 2);
        assert_eq!(counts["Abbott, Ryan"]["2026-02"], 4.0);
        assert_eq!(counts["Abbott, Ryan"]["2026-03"], 2.0);
        assert_eq!(counts["Abbas, Jack"]["2026-02"], 6.0);
        // The hire date (July 2026 / April 2026) must not be used as the month
        assert_eq!(counts["Abbott, Ryan"].get("2026-07"), None);
        assert_eq!(names_in(&tables, None), vec!["Abbas, Jack", "Abbott, Ryan"]);
        assert_eq!(observer_query_name(&tables, None).as_deref(), Some("Employees.Personnel Number"));
    }

    // A table read from the page as text (no measure information).
    #[test]
    fn reads_text_table_from_page() {
        let t = DecodedTable {
            columns: vec!["Pers.no.".into(), "Personnel Number".into(), "Hire Date".into(), "January".into(), "February".into(), "March".into()],
            rows: vec![
                vec![json!("237126"), json!("Abbott, Ryan"), json!("7/6/2026"), json!("1"), json!("4"), json!("")],
                vec![json!("15112"), json!("Abbas, Jack"), json!("4/20/2026"), json!(""), json!("6"), json!("2")],
            ],
            measures: vec![false; 6],
        };
        let counts = aggregate(&[t], &ColumnHints::default(), 2026);
        assert_eq!(counts["Abbott, Ryan"]["2026-01"], 1.0);
        assert_eq!(counts["Abbott, Ryan"]["2026-02"], 4.0);
        assert_eq!(counts["Abbas, Jack"]["2026-03"], 2.0);
        assert_eq!(counts["Abbott, Ryan"].get("2026-07"), None);
    }

    // The real report row: 11 employee fields, then 12 count measures whose
    // names are inconsistent; the right-most is the current month.
    #[test]
    fn reads_rolling_twelve_months() {
        let mut columns: Vec<String> = ["Sum(Headcount.Pers.no.)", "Headcount.Personnel Number", "Headcount.Date", "Headcount.Employment Type", "Headcount.Region",
            "Headcount.Reporting Location", "Headcount.Sector", "Headcount.Business Unit", "Headcount.Cost Center", "Headcount.Corporate function", "Headcount.Email"]
            .iter().map(|s| s.to_string()).collect();
        columns.extend(["ObsCountNov21", "ObsCountDec22", "January", "23Feb", "Mar2023", "Apr2023", "May2023", "June2023", "July2023", "August2024", "Sept2023", "ObsCountOct22"].iter().map(|s| format!("Headcount.{}", s)));
        let mut measures = vec![false; 11];
        measures.extend(vec![true; 12]);
        let mut row = vec![json!(76024), json!("Combrink, Sybrandt"), json!(1454284800000_i64), json!("Permanent"), json!("AIM"), json!("Cape Town"),
            json!("Delivery Practices - PDG"), json!("Engineering Delivery"), json!("Mechanical"), json!(""), json!("sybrandt.combrink@hatch.com")];
        row.extend([4, 4, 11, 11, 18, 12, 9, 6, 4, 6, 5, 4].iter().map(|n| json!(n)));
        let table = DecodedTable { columns, rows: vec![row], measures };
        let hints = ColumnHints { rolling: Some((12, (2026, 10))), ..Default::default() };
        let counts = aggregate(&[table.clone()], &hints, 2026);
        let me = &counts["Combrink, Sybrandt"];
        let expected = [("2025-11", 4.0), ("2025-12", 4.0), ("2026-01", 11.0), ("2026-02", 11.0), ("2026-03", 18.0), ("2026-04", 12.0),
            ("2026-05", 9.0), ("2026-06", 6.0), ("2026-07", 4.0), ("2026-08", 6.0), ("2026-09", 5.0), ("2026-10", 4.0)];
        for (month, n) in expected {
            assert_eq!(me[month], n, "{}", month);
        }
        assert_eq!(me.len(), 12);
        // Months come from the column names; in January 2027 the "January"
        // column is January 2027 and the rest belong to 2026.
        let jan = aggregate(&[table], &ColumnHints { rolling: Some((12, (2027, 1))), ..Default::default() }, 2027);
        assert_eq!(jan["Combrink, Sybrandt"]["2027-01"], 11.0);
        assert_eq!(jan["Combrink, Sybrandt"]["2026-02"], 11.0);
        assert_eq!(jan["Combrink, Sybrandt"]["2026-12"], 4.0);
    }

    #[test]
    fn months_from_column_names() {
        assert_eq!(named_month("ObsCountNov21"), Some(11));
        assert_eq!(named_month("23Feb"), Some(2));
        assert_eq!(named_month("Sept2023"), Some(9));
        assert_eq!(named_month("June2023"), Some(6));
        assert_eq!(named_month("August2024"), Some(8));
        assert_eq!(named_month("January"), Some(1));
        assert_eq!(named_month("Total"), None);
        // Columns out of order still get the right month; positional order would not.
        let names = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"];
        let t = DecodedTable { columns: names.iter().map(|n| format!("T.ObsCount{}22", n)).collect(), rows: vec![], measures: vec![true; 12] };
        let (months, by_name) = rolling_months(&t, &(0..12).collect::<Vec<_>>(), (2026, 10));
        assert!(by_name);
        assert_eq!(months[0], "2026-10");
        assert_eq!(months[1], "2025-11");
        assert_eq!(months[11], "2026-09");
        // A column without a month name: fall back to position.
        let mut t2 = t.clone();
        t2.columns[5] = "T.Total".into();
        let (months, by_name) = rolling_months(&t2, &(0..12).collect::<Vec<_>>(), (2026, 10));
        assert!(!by_name);
        assert_eq!(months[0], "2025-11");
        assert_eq!(months[11], "2026-10");
    }

    #[test]
    fn reads_server_timestamp_and_checks_dates() {
        let bodies = vec![
            r#"{"results":[{"result":{"data":{"timestamp":"/Date(1793388365012)/"}}}]}"#.to_string(),
            r#"{"results":[{"result":{"data":{"timestamp":"/Date(1793388364997)/"}}}]}"#.to_string(),
        ];
        assert_eq!(data_timestamp(&bodies), Some(1793388365012));
        let dates = DecodedTable {
            columns: vec!["vwPBObservation.Observation Date".into()],
            // 6, 10 and 11 Jan 2026; 3 Feb 2026
            rows: vec![vec![json!(1767657600000_i64)], vec![json!(1768003200000_i64)], vec![json!(1768089600000_i64)], vec![json!(1770076800000_i64)]],
            measures: vec![false],
        };
        let mut months = BTreeMap::new();
        months.insert("2026-01".to_string(), 11.0);
        months.insert("2026-02".to_string(), 0.0);
        let notes = check_against_dates(&[dates], &months);
        assert_eq!(notes, vec!["2026-02: 1 days with observations but a count of 0"]);
    }

    #[test]
    fn builds_name_candidates() {
        assert_eq!(name_candidates(Some("Ryan"), Some("Abbott"), Some("Ryan Abbott")), vec!["Abbott, Ryan"]);
        assert_eq!(name_candidates(Some("Osama"), Some("Abdul Rehman"), None), vec!["Abdul Rehman, Osama"]);
        assert_eq!(name_candidates(None, None, Some("Abbott, Ryan (Hatch)")), vec!["Abbott, Ryan"]);
        assert_eq!(name_candidates(Some("Jack"), Some("Abbas"), Some("Abbas, Jack T.")), vec!["Abbas, Jack", "Abbas, Jack T."]);
        assert!(name_candidates(None, None, None).is_empty());
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
        assert_eq!(month_key(&json!("Market"), 2026), None);
        assert_eq!(month_key(&json!("Sept"), 2026).as_deref(), Some("2026-09"));
    }

    #[test]
    fn base64_round_trip() {
        assert_eq!(base64_decode("eyJhIjoxfQ==").as_deref(), Some("{\"a\":1}"));
    }
}
