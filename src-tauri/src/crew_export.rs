// Excel export of the crew's monthly observation counts.

use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};
use serde::Deserialize;

/// Hatch red, for the heading row.
const HEADING: u32 = 0xE2231A;
/// Hatch dark blue-grey, behind the names.
const NAMES: u32 = 0x425563;
/// The sidebar's month colours: none, 1-3, target met.
const NONE: u32 = 0xCF222E;
const PARTIAL: u32 = 0xBC5A00;
const MET: u32 = 0x1A7F37;

#[derive(Debug, Deserialize)]
pub struct CrewRow {
    pub name: String,
    /// One count per month, January first
    pub counts: Vec<u32>,
}

/// Writes the crew's counts (one row per person, one column per month so
/// far this year, plus a total) to an .xlsx file and opens it.
#[tauri::command]
pub async fn export_crew_xlsx(path: String, year: i32, months: Vec<String>, rows: Vec<CrewRow>, target: u32) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name(format!("Crew {}", year)).map_err(|e| e.to_string())?;

    let cell = |fill: u32| {
        Format::new()
            .set_background_color(Color::RGB(fill))
            .set_font_color(Color::White)
            .set_border(FormatBorder::Thin)
            .set_border_color(Color::White)
    };
    let heading = cell(HEADING).set_bold().set_align(FormatAlign::Center);
    let heading_name = cell(HEADING).set_bold();
    let name = cell(NAMES).set_bold();
    let count = |n: u32| cell(if n == 0 { NONE } else if n < target { PARTIAL } else { MET }).set_align(FormatAlign::Center);
    let total = Format::new().set_bold().set_align(FormatAlign::Center).set_border(FormatBorder::Thin).set_border_color(Color::RGB(0xBFBFBF));

    let err = |e: rust_xlsxwriter::XlsxError| e.to_string();
    sheet.write_with_format(0, 0, "Name", &heading_name).map_err(err)?;
    for (i, m) in months.iter().enumerate() {
        sheet.write_with_format(0, (i + 1) as u16, m.as_str(), &heading).map_err(err)?;
    }
    let total_col = (months.len() + 1) as u16;
    sheet.write_with_format(0, total_col, "Total", &heading).map_err(err)?;

    for (r, row) in rows.iter().enumerate() {
        let r = (r + 1) as u32;
        sheet.write_with_format(r, 0, row.name.as_str(), &name).map_err(err)?;
        for (i, _) in months.iter().enumerate() {
            let n = row.counts.get(i).copied().unwrap_or(0);
            sheet.write_with_format(r, (i + 1) as u16, n, &count(n)).map_err(err)?;
        }
        let sum: u32 = row.counts.iter().take(months.len()).sum();
        sheet.write_with_format(r, total_col, sum, &total).map_err(err)?;
    }

    let longest = rows.iter().map(|r| r.name.chars().count()).max().unwrap_or(10);
    sheet.set_column_width(0, (longest.max(10) + 3) as f64).map_err(err)?;
    for c in 1..=total_col {
        sheet.set_column_width(c, 8).map_err(err)?;
    }
    sheet.set_freeze_panes(1, 1).map_err(err)?;
    workbook.save(&path).map_err(|e| format!("Could not save the file (is it open in Excel?): {}", e))?;
    open_file(&path);
    Ok(())
}

#[cfg(windows)]
fn open_file(path: &str) {
    let _ = std::process::Command::new("explorer").arg(path).spawn();
}

#[cfg(not(windows))]
fn open_file(_path: &str) {}
