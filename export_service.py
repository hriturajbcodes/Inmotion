"""
Jindal Steel & Power - In-Motion Weighbridge Report Service
Generates styled multi-sheet Excel (.xlsx) and CSV reports.
"""

import io
import csv
import math
import datetime
import openpyxl
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter


def _clean(val):
    """Make a value safe for an Excel cell: Excel rejects control characters, holds at
    most 32,767 characters per cell and cannot store NaN/Infinity (those become empty).
    Anything that is not plain text or a number is written as text."""
    if isinstance(val, float):
        return val if math.isfinite(val) else None
    if val is None or isinstance(val, (int, bool)):
        return val
    return ILLEGAL_CHARACTERS_RE.sub("", str(val))[:32767]


def _fmt2(val):
    """Two-decimal text for the CSV; anything that is not a usable number becomes empty."""
    try:
        f = float(val)
    except (TypeError, ValueError):
        return ""
    return f"{f:.2f}" if math.isfinite(f) else ""


def generate_excel_report(records, stats, metadata):
    wb = openpyxl.Workbook()

    # 1. Main Sheet: Weighment Records
    ws_records = wb.active
    ws_records.title = "Weighment Records"
    ws_records.views.sheetView[0].showGridLines = True

    # Styling Palettes
    title_font = Font(name="Segoe UI", size=15, bold=True, color="0F172A")
    subtitle_font = Font(name="Segoe UI", size=11, bold=True, color="334155")
    meta_font = Font(name="Segoe UI", size=9, italic=True, color="64748B")
    header_font = Font(name="Segoe UI", size=10, bold=True, color="FFFFFF")
    data_font = Font(name="Segoe UI", size=9, color="0F172A")
    bold_data_font = Font(name="Segoe UI", size=9, bold=True, color="0F172A")

    header_fill = PatternFill(start_color="1E293B", end_color="1E293B", fill_type="solid")
    alt_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
    net_fill = PatternFill(start_color="EFF6FF", end_color="EFF6FF", fill_type="solid")      # light blue
    delta_fill = PatternFill(start_color="FEF3C7", end_color="FEF3C7", fill_type="solid")    # soft amber

    border_thin = Border(
        left=Side(style="thin", color="CBD5E1"),
        right=Side(style="thin", color="CBD5E1"),
        top=Side(style="thin", color="CBD5E1"),
        bottom=Side(style="thin", color="CBD5E1"),
    )

    # Title Area
    ws_records["A1"] = "Jindal Steel"
    ws_records["A1"].font = title_font
    ws_records["A2"] = "In-Motion Weighbridge Comparison Report"
    ws_records["A2"].font = subtitle_font

    gen_time = metadata.get("generated_at", datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    area = metadata.get("area", "ALL")
    date_range = metadata.get("date_range", "All Data")
    filter_desc = metadata.get("filters", "None")
    ws_records["A3"] = _clean(
        f"Generated: {gen_time} | Production Area: {area} | "
        f"Date Range: {date_range} | Active Filters: {filter_desc}"
    )
    ws_records["A3"].font = meta_font

    headers = [
        "Cast ID",
        "Torpedo No.",
        "Source",
        "Static Gross (MT)",
        "Static Tare (MT)",
        "Static Net (MT)",
        "In-Motion Gross (MT)",
        "In-Motion Tare (MT)",
        "In-Motion Net (MT)",
        "Net Difference (MT)",
        "Net Difference (%)",
        "Production Time",
        "Match Status",
    ]

    header_row_idx = 5
    for col_idx, h in enumerate(headers, 1):
        cell = ws_records.cell(row=header_row_idx, column=col_idx, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = border_thin
    ws_records.row_dimensions[header_row_idx].height = 28

    current_row = header_row_idx
    for r in records:
        current_row += 1
        ws_records.row_dimensions[current_row].height = 19
        row_fill = alt_fill if (current_row % 2 == 0) else None

        values = [
            (r.get("BFCASTID") or "-", "left", bold_data_font, row_fill, "@"),
            (r.get("TORPEDO_NO") or "-", "center", bold_data_font, row_fill, "@"),
            (r.get("STATIC_SOURCE") or "-", "center", data_font, row_fill, "@"),
            (r.get("STATIC_GROSS_WT"), "right", data_font, row_fill, "0.00"),
            (r.get("STATIC_TARE_WT"), "right", data_font, row_fill, "0.00"),
            (r.get("STATIC_NET_WT"), "right", bold_data_font, net_fill, "0.00"),
            (r.get("IMWB_GROSS_WT"), "right", data_font, row_fill, "0.00"),
            (r.get("IMWB_TARE_WT"), "right", data_font, row_fill, "0.00"),
            (r.get("IMWB_NET_WT"), "right", bold_data_font, net_fill, "0.00"),
            (r.get("NET_WT_DIFFERENCE"), "right", bold_data_font, delta_fill, "+0.00;-0.00;0.00"),
            (r.get("NET_WT_DIFFERENCE_PCT"), "right", data_font, delta_fill, "+0.00%;-0.00%;0.00%"),
            (r.get("STATIC_RECORD_TIME") or "-", "center", data_font, row_fill, "YYYY-MM-DD HH:MM:SS"),
            (r.get("MATCH_STATUS") or "-", "center", bold_data_font, row_fill, "@"),
        ]

        for col_idx, (val, align, font, fill, num_fmt) in enumerate(values, 1):
            val = _clean(val)
            cell = ws_records.cell(row=current_row, column=col_idx)
            cell.alignment = Alignment(horizontal=align, vertical="center")
            cell.font = font
            cell.border = border_thin
            if fill:
                cell.fill = fill
            if val is not None and val != "-":
                cell.value = val
                cell.number_format = num_fmt
            else:
                cell.value = "-"

    # Freeze header and enable Excel Autofilter
    ws_records.freeze_panes = "A6"
    ws_records.auto_filter.ref = f"A5:M{max(current_row, 5)}"

    # Auto column sizing
    for col in ws_records.columns:
        max_len = 0
        col_letter = get_column_letter(col[0].column)
        for cell in col:
            v_str = str(cell.value or "")
            if len(v_str) > max_len:
                max_len = len(v_str)
        ws_records.column_dimensions[col_letter].width = max(max_len + 4, 12)

    # 2. Executive Summary Sheet
    ws_summary = wb.create_sheet(title="Summary")
    ws_summary.views.sheetView[0].showGridLines = True

    ws_summary["A1"] = "Jindal Steel"
    ws_summary["A1"].font = title_font
    ws_summary["A2"] = "Weighment Statistical Summary"
    ws_summary["A2"].font = subtitle_font
    ws_summary["A3"] = _clean(f"Evaluation Window: {date_range} | Production Area: {area}")
    ws_summary["A3"].font = meta_font

    sum_headers = ["Metric", "Value", "Unit / Operational Context"]
    for col_idx, h in enumerate(sum_headers, 1):
        cell = ws_summary.cell(row=5, column=col_idx, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center" if col_idx > 1 else "left", vertical="center")
        cell.border = border_thin
    ws_summary.row_dimensions[5].height = 25

    summary_rows = [
        ("Exported trips", stats.get("total_records", len(records)), "Total torpedo rows exported"),
        ("Matched trips", stats.get("matched_records", 0), "Complete matched trips (all 6 weights non-null)"),
        ("Average signed delta", stats.get("mean", 0.0), "MT (Static Net - In-Motion Net)"),
        ("Median delta", stats.get("median", 0.0), "MT (Typical trip difference)"),
        ("Standard deviation", stats.get("stdev", 0.0), "MT (Scale repeatability)"),
        ("P90 absolute delta", stats.get("p90_abs", 0.0), "MT (Observed historical error envelope)"),
        ("Static Net total", stats.get("static_net_total", 0.0), "MT (Total hot-metal weighed statically)"),
        ("In-Motion Net total", stats.get("imwb_net_total", 0.0), "MT (Total hot-metal weighed in-motion)"),
        ("Total signed delta", stats.get("total_signed_delta", 0.0), "MT (Cumulative scale variance)"),
    ]

    for idx, (metric, val, desc) in enumerate(summary_rows, 6):
        c1 = ws_summary.cell(row=idx, column=1, value=metric)
        c2 = ws_summary.cell(row=idx, column=2, value=val)
        c3 = ws_summary.cell(row=idx, column=3, value=desc)
        for c in (c1, c2, c3):
            c.border = border_thin
            c.font = data_font
        c1.font = bold_data_font
        c2.alignment = Alignment(horizontal="right")
        if isinstance(val, float):
            c2.number_format = "#,##0.00"
        elif isinstance(val, int):
            c2.number_format = "#,##0"

    ws_summary.column_dimensions["A"].width = 28
    ws_summary.column_dimensions["B"].width = 18
    ws_summary.column_dimensions["C"].width = 46

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.getvalue()


def generate_csv_report(records):
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\n")

    headers = [
        "Cast ID",
        "Torpedo No.",
        "Source",
        "Static Gross (MT)",
        "Static Tare (MT)",
        "Static Net (MT)",
        "In-Motion Gross (MT)",
        "In-Motion Tare (MT)",
        "In-Motion Net (MT)",
        "Net Difference (MT)",
        "Net Difference (%)",
        "Production Time",
        "Match Status",
    ]
    writer.writerow(headers)

    for r in records:
        writer.writerow([
            r.get("BFCASTID") or "",
            r.get("TORPEDO_NO") or "",
            r.get("STATIC_SOURCE") or "",
            _fmt2(r.get("STATIC_GROSS_WT")),
            _fmt2(r.get("STATIC_TARE_WT")),
            _fmt2(r.get("STATIC_NET_WT")),
            _fmt2(r.get("IMWB_GROSS_WT")),
            _fmt2(r.get("IMWB_TARE_WT")),
            _fmt2(r.get("IMWB_NET_WT")),
            _fmt2(r.get("NET_WT_DIFFERENCE")),
            _fmt2(r.get("NET_WT_DIFFERENCE_PCT")),
            r.get("STATIC_RECORD_TIME") or "",
            r.get("MATCH_STATUS") or "",
        ])

    return output.getvalue().encode("utf-8")