/**
 * Jindal Steel & Power - SMS Digital Transformation & Automation
 * In-Motion + Static Weighbridge Dashboard Application Client
 */

(function () {
    "use strict";

    // Application State
    var state = {
        area: "ALL",
        days: "7",
        chartCount: "10",
        insightsDate: "",
        tableRows: [],
        filteredRows: [],
        sortCol: "STATIC_RECORD_TIME",
        sortDir: "desc",
        pageSize: 10,
        currentPage: 1,
        activeColumnFilters: {},
        globalSearch: ""
    };

    // DOM Element References
    var el = {
        // Global / Header
        themeToggle: document.getElementById("btn-theme-toggle"),
        printBtn: document.getElementById("btn-print"),
        dbStatusDot: document.getElementById("db-status-dot"),
        headerDataCurrent: document.getElementById("header-data-current"),
        globalAreaSelect: document.getElementById("global-area-select"),
        globalDateSelect: document.getElementById("global-date-select"),

        // KPI Cards
        kpiCastId: document.getElementById("kpi-cast-id"),
        kpiTorpedoNo: document.getElementById("kpi-torpedo-no"),
        kpiSource: document.getElementById("kpi-source"),
        kpiProdTime: document.getElementById("kpi-prod-time"),
        kpiStaticNet: document.getElementById("kpi-static-net"),
        kpiStaticGross: document.getElementById("kpi-static-gross"),
        kpiStaticGrossTime: document.getElementById("kpi-static-gross-time"),
        kpiStaticTare: document.getElementById("kpi-static-tare"),
        kpiStaticTareTime: document.getElementById("kpi-static-tare-time"),
        kpiImwbNet: document.getElementById("kpi-imwb-net"),
        kpiImwbGross: document.getElementById("kpi-imwb-gross"),
        kpiImwbGrossTime: document.getElementById("kpi-imwb-gross-time"),
        kpiImwbTare: document.getElementById("kpi-imwb-tare"),
        kpiImwbTareTime: document.getElementById("kpi-imwb-tare-time"),
        kpiNetDiffMt: document.getElementById("kpi-net-diff-mt"),
        kpiNetDiffPct: document.getElementById("kpi-net-diff-pct"),

        // Chart
        chartContainer: document.getElementById("chart-container"),
        chartCapNotice: document.getElementById("chart-cap-notice"),
        chartEmptyState: document.getElementById("chart-empty-state"),
        chartButtons: document.querySelectorAll("[data-chart-count]"),

        // Table
        tableBody: document.getElementById("weighment-table-body"),
        tableSearch: document.getElementById("table-search-input"),
        btnToggleFilters: document.getElementById("btn-toggle-filters"),
        tableFilterRow: document.getElementById("table-filter-row"),
        tablePageSize: document.getElementById("table-page-size"),
        tableRecordCount: document.getElementById("table-record-count"),
        tablePaginationInfo: document.getElementById("table-pagination-info"),
        btnPrevPage: document.getElementById("btn-prev-page"),
        btnNextPage: document.getElementById("btn-next-page"),
        paginationPages: document.getElementById("pagination-pages"),
        tableEmptyState: document.getElementById("table-empty-state"),

        // Export Modal
        btnOpenExport: document.getElementById("btn-open-export"),
        exportModal: document.getElementById("export-modal"),
        btnCloseExport: document.getElementById("btn-close-export"),
        btnCancelExport: document.getElementById("btn-cancel-export"),
        btnConfirmExport: document.getElementById("btn-confirm-export"),
        exportScopeSelect: document.getElementById("export-scope-select"),
        exportCustomRange: document.getElementById("export-custom-range"),
        exportFromDate: document.getElementById("export-from-date"),
        exportToDate: document.getElementById("export-to-date"),
        exportAreaSelect: document.getElementById("export-area-select"),
        exportFormatSelect: document.getElementById("export-format-select"),
        exportSummaryArea: document.getElementById("export-summary-area"),
        exportSummaryRange: document.getElementById("export-summary-range"),
        exportSummaryFilters: document.getElementById("export-summary-filters"),
        exportSummaryRows: document.getElementById("export-summary-rows"),

        // Insights Page
        insightsAreaSelect: document.getElementById("insights-area-select"),
        insightsDateSelect: document.getElementById("insights-date-select"),
        insightsWindowDisplay: document.getElementById("insights-window-display"),
        pivotTableBody: document.getElementById("pivot-table-body"),
        interpretationList: document.getElementById("interpretation-list")
    };

    // Theme Management
    function initTheme() {
        if (!el.themeToggle) return;
        el.themeToggle.addEventListener("click", function () {
            var cur = document.documentElement.getAttribute("data-theme") || "dark";
            var next = cur === "dark" ? "light" : "dark";
            document.documentElement.setAttribute("data-theme", next);
            localStorage.setItem("imwb_theme", next);
        });
    }

    // Print Handling
    function initPrint() {
        if (el.printBtn) {
            el.printBtn.addEventListener("click", function () {
                window.print();
            });
        }
    }

    // Fetch Dashboard Data
    function loadDashboardData() {
        var url = "/api/dashboard?area=" + encodeURIComponent(state.area) +
            "&days=" + encodeURIComponent(state.days) +
            "&chart_count=" + encodeURIComponent(state.chartCount);

        fetch(url)
            .then(function (res) { return res.json(); })
            .then(function (data) {
                renderKPIs(data.summary.latest_complete_matched);
                renderChart(data.chart_data, data.summary.chart_capped, data.summary.total_matched_available);
                state.tableRows = data.rows || [];
                applyTableFiltersAndRender();
                if (el.headerDataCurrent && state.tableRows.length > 0) {
                    el.headerDataCurrent.textContent = "Data current to " + state.tableRows[0].STATIC_RECORD_TIME;
                }
            })
            .catch(function (err) {
                console.error("Dashboard fetch error:", err);
            });
    }

    // Render KPI Cards (Strict Acceptance Criteria: Section 12)
    function renderKPIs(trip) {
        if (!trip) {
            if (el.kpiCastId) el.kpiCastId.textContent = "N/A";
            if (el.kpiTorpedoNo) el.kpiTorpedoNo.textContent = "N/A";
            if (el.kpiSource) el.kpiSource.textContent = "N/A";
            if (el.kpiProdTime) el.kpiProdTime.textContent = "No complete matched trip in scope";
            if (el.kpiStaticNet) el.kpiStaticNet.textContent = "--";
            if (el.kpiStaticGross) el.kpiStaticGross.textContent = "-- MT";
            if (el.kpiStaticTare) el.kpiStaticTare.textContent = "-- MT";
            if (el.kpiImwbNet) el.kpiImwbNet.textContent = "--";
            if (el.kpiImwbGross) el.kpiImwbGross.textContent = "-- MT";
            if (el.kpiImwbTare) el.kpiImwbTare.textContent = "-- MT";
            if (el.kpiNetDiffMt) el.kpiNetDiffMt.textContent = "--";
            if (el.kpiNetDiffPct) el.kpiNetDiffPct.textContent = "-- %";
            return;
        }

        if (el.kpiCastId) el.kpiCastId.textContent = trip.BFCASTID || "-";
        if (el.kpiTorpedoNo) el.kpiTorpedoNo.textContent = trip.TORPEDO_NO || "-";
        if (el.kpiSource) el.kpiSource.textContent = trip.STATIC_SOURCE || "-";
        if (el.kpiProdTime) el.kpiProdTime.textContent = trip.STATIC_RECORD_TIME || "-";

        if (el.kpiStaticNet) el.kpiStaticNet.textContent = formatNum(trip.STATIC_NET_WT);
        if (el.kpiStaticGross) el.kpiStaticGross.textContent = formatNum(trip.STATIC_GROSS_WT) + " MT";
        if (el.kpiStaticGrossTime) el.kpiStaticGrossTime.textContent = trip.STATIC_GROSS_TIME || "-";
        if (el.kpiStaticTare) el.kpiStaticTare.textContent = formatNum(trip.STATIC_TARE_WT) + " MT";
        if (el.kpiStaticTareTime) el.kpiStaticTareTime.textContent = trip.STATIC_TARE_TIME || "-";

        if (el.kpiImwbNet) el.kpiImwbNet.textContent = formatNum(trip.IMWB_NET_WT);
        if (el.kpiImwbGross) el.kpiImwbGross.textContent = formatNum(trip.IMWB_GROSS_WT) + " MT";
        if (el.kpiImwbGrossTime) el.kpiImwbGrossTime.textContent = trip.IMWB_GROSS_TIME || "-";
        if (el.kpiImwbTare) el.kpiImwbTare.textContent = formatNum(trip.IMWB_TARE_WT) + " MT";
        if (el.kpiImwbTareTime) el.kpiImwbTareTime.textContent = trip.IMWB_TARE_TIME || "-";

        var diff = trip.NET_WT_DIFFERENCE;
        var diffPct = trip.NET_WT_DIFFERENCE_PCT;
        if (el.kpiNetDiffMt) {
            el.kpiNetDiffMt.textContent = (diff > 0 ? "+" : "") + formatNum(diff);
            el.kpiNetDiffMt.style.color = diff > 0 ? "var(--color-delta-pos)" : (diff < 0 ? "var(--color-delta-neg)" : "var(--color-zero)");
        }
        if (el.kpiNetDiffPct) {
            el.kpiNetDiffPct.textContent = (diffPct > 0 ? "+" : "") + formatNum(diffPct) + " %";
        }
    }

    // Dynamic Symmetrical SVG Vertical Bar Chart (Section 13)
    function renderChart(data, isCapped, totalAvailable) {
        if (!el.chartContainer) return;

        if (el.chartCapNotice) {
            if (isCapped) {
                el.chartCapNotice.style.display = "block";
                el.chartCapNotice.textContent = "Showing latest 20,000 of " + totalAvailable + " matched trips";
            } else {
                el.chartCapNotice.style.display = "none";
            }
        }

        if (!data || data.length === 0) {
            el.chartContainer.innerHTML = "";
            if (el.chartEmptyState) el.chartEmptyState.style.display = "block";
            return;
        }
        if (el.chartEmptyState) el.chartEmptyState.style.display = "none";

        var width = Math.max(el.chartContainer.clientWidth || 980, data.length * 62);
        var height = 360;
        var pad = { top: 38, right: 28, bottom: 58, left: 88 };
        var plotW = width - pad.left - pad.right;
        var plotH = height - pad.top - pad.bottom;

        var maxAbs = 0.5;
        for (var i = 0; i < data.length; i++) {
            var a = Math.abs(data[i].delta);
            if (a > maxAbs) maxAbs = a;
        }
        var yBound = Math.ceil(maxAbs * 1.25);
        if (yBound < 2) yBound = 2;

        var zeroY = pad.top + plotH / 2;
        var slotW = plotW / data.length;
        var barW = Math.min(Math.max(slotW * 0.55, 14), 44);

        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", width);
        svg.setAttribute("height", height);
        svg.setAttribute("viewBox", "0 0 " + width + " " + height);

        // Y-axis Large Bold Title
        var yTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
        yTitle.setAttribute("x", -zeroY);
        yTitle.setAttribute("y", 22);
        yTitle.setAttribute("transform", "rotate(-90)");
        yTitle.setAttribute("class", "axis-title-large");
        yTitle.setAttribute("text-anchor", "middle");
        yTitle.textContent = "NET WEIGHT DIFFERENCE (MT)";
        svg.appendChild(yTitle);

        // Gridlines & Ticks (-yBound to +yBound)
        var steps = 4;
        for (var s = -steps; s <= steps; s++) {
            var val = (s / steps) * yBound;
            var curY = pad.top + ((yBound - val) / (2 * yBound)) * plotH;

            var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", pad.left);
            line.setAttribute("x2", width - pad.right);
            line.setAttribute("y1", curY);
            line.setAttribute("y2", curY);
            line.setAttribute("stroke", s === 0 ? "var(--chart-zero-line)" : "var(--chart-grid-line)");
            line.setAttribute("stroke-width", s === 0 ? "2" : "1");
            svg.appendChild(line);

            var tickLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
            tickLabel.setAttribute("x", pad.left - 10);
            tickLabel.setAttribute("y", curY + 4);
            tickLabel.setAttribute("class", "bar-axis-label");
            tickLabel.setAttribute("text-anchor", "end");
            tickLabel.textContent = (val > 0 ? "+" : "") + val.toFixed(1);
            svg.appendChild(tickLabel);
        }

        // Draw Bars & Permanent Labels
        for (var b = 0; b < data.length; b++) {
            var item = data[b];
            var delta = item.delta;
            var cx = pad.left + (b + 0.5) * slotW;
            var barY = pad.top + ((yBound - delta) / (2 * yBound)) * plotH;
            var topY = delta >= 0 ? barY : zeroY;
            var bH = Math.max(Math.abs(zeroY - barY), 2);

            var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", cx - barW / 2);
            rect.setAttribute("y", topY);
            rect.setAttribute("width", barW);
            rect.setAttribute("height", bH);
            rect.setAttribute("rx", "2");
            rect.setAttribute("fill", delta >= 0 ? "var(--color-delta-pos)" : "var(--color-delta-neg)");
            rect.setAttribute("class", "svg-bar");
            svg.appendChild(rect);

            // Permanent Bar Value Label (+9.48 MT / -14.29 MT)
            var vText = document.createElementNS("http://www.w3.org/2000/svg", "text");
            vText.setAttribute("x", cx);
            vText.setAttribute("y", delta >= 0 ? topY - 7 : topY + bH + 13);
            vText.setAttribute("class", "bar-val-label");
            vText.setAttribute("fill", delta >= 0 ? "var(--color-delta-pos)" : "var(--color-delta-neg)");
            vText.textContent = (delta > 0 ? "+" : "") + delta.toFixed(2) + " MT";
            svg.appendChild(vText);

            // X-axis Torpedo No. & Time
            var tNo = document.createElementNS("http://www.w3.org/2000/svg", "text");
            tNo.setAttribute("x", cx);
            tNo.setAttribute("y", height - pad.bottom + 18);
            tNo.setAttribute("class", "bar-axis-label");
            tNo.setAttribute("font-weight", "700");
            tNo.setAttribute("fill", "var(--text-primary)");
            tNo.textContent = item.torpedo_no;
            svg.appendChild(tNo);

            var tTime = document.createElementNS("http://www.w3.org/2000/svg", "text");
            tTime.setAttribute("x", cx);
            tTime.setAttribute("y", height - pad.bottom + 32);
            tTime.setAttribute("class", "bar-axis-label");
            tTime.textContent = item.prod_time;
            svg.appendChild(tTime);
        }

        el.chartContainer.innerHTML = "";
        el.chartContainer.appendChild(svg);
    }

    // Table Filtering, Sorting, and Pagination (Sections 15 & 16)
    function applyTableFiltersAndRender() {
        var rows = state.tableRows.slice();

        // Global Search
        if (state.globalSearch) {
            var q = state.globalSearch.toLowerCase();
            rows = rows.filter(function (r) {
                return (
                    (r.BFCASTID && r.BFCASTID.toLowerCase().indexOf(q) !== -1) ||
                    (r.TORPEDO_NO && r.TORPEDO_NO.toLowerCase().indexOf(q) !== -1) ||
                    (r.STATIC_SOURCE && r.STATIC_SOURCE.toLowerCase().indexOf(q) !== -1) ||
                    (r.MATCH_STATUS && r.MATCH_STATUS.toLowerCase().indexOf(q) !== -1)
                );
            });
        }

        // Per-Column Filters (with numeric operators >10, <5, >=20, <=15, =0)
        var cols = Object.keys(state.activeColumnFilters);
        for (var i = 0; i < cols.length; i++) {
            var col = cols[i];
            var fVal = state.activeColumnFilters[col].trim();
            if (!fVal) continue;

            rows = rows.filter(function (r) {
                var cell = r[col];
                if (cell === null || cell === undefined) return false;

                // Numeric Operator Check
                if (/^(>=|<=|>|<|=)/.test(fVal)) {
                    var op = fVal.match(/^(>=|<=|>|<|=)/)[0];
                    var target = parseFloat(fVal.slice(op.length));
                    var numCell = parseFloat(cell);
                    if (isNaN(numCell) || isNaN(target)) return false;
                    if (op === ">=") return numCell >= target;
                    if (op === "<=") return numCell <= target;
                    if (op === ">") return numCell > target;
                    if (op === "<") return numCell < target;
                    if (op === "=") return numCell === target;
                }
                return String(cell).toLowerCase().indexOf(fVal.toLowerCase()) !== -1;
            });
        }

        // Sorting
        var sCol = state.sortCol;
        var sDir = state.sortDir === "asc" ? 1 : -1;
        rows.sort(function (a, b) {
            var vA = a[sCol];
            var vB = b[sCol];
            if (vA === null || vA === undefined) return 1;
            if (vB === null || vB === undefined) return -1;
            if (typeof vA === "number" && typeof vB === "number") return (vA - vB) * sDir;
            return String(vA).localeCompare(String(vB)) * sDir;
        });

        state.filteredRows = rows;
        if (el.tableRecordCount) el.tableRecordCount.textContent = rows.length + " records";

        renderTable();
    }

    function renderTable() {
        if (!el.tableBody) return;
        var rows = state.filteredRows;

        if (rows.length === 0) {
            el.tableBody.innerHTML = "";
            if (el.tableEmptyState) el.tableEmptyState.style.display = "block";
            if (el.tablePaginationInfo) el.tablePaginationInfo.textContent = "Showing 0 to 0 of 0";
            return;
        }
        if (el.tableEmptyState) el.tableEmptyState.style.display = "none";

        var pSize = state.pageSize === "all" ? rows.length : parseInt(state.pageSize, 10);
        var totalPages = Math.ceil(rows.length / pSize) || 1;
        state.currentPage = Math.min(state.currentPage, totalPages);

        var startIdx = (state.currentPage - 1) * pSize;
        var endIdx = Math.min(startIdx + pSize, rows.length);
        var pageRows = rows.slice(startIdx, endIdx);

        var html = "";
        for (var i = 0; i < pageRows.length; i++) {
            var r = pageRows[i];
            var diff = r.NET_WT_DIFFERENCE;
            var diffColor = diff > 0 ? "var(--color-delta-pos)" : (diff < 0 ? "var(--color-delta-neg)" : "inherit");

            html += "<tr>" +
                "<td><strong>" + (r.BFCASTID || "-") + "</strong></td>" +
                "<td><strong>" + (r.TORPEDO_NO || "-") + "</strong></td>" +
                "<td>" + (r.STATIC_SOURCE || "-") + "</td>" +
                "<td class='num-col'>" + formatNum(r.STATIC_GROSS_WT) + "</td>" +
                "<td class='num-col'>" + formatNum(r.STATIC_TARE_WT) + "</td>" +
                "<td class='num-col'><strong>" + formatNum(r.STATIC_NET_WT) + "</strong></td>" +
                "<td class='num-col'>" + formatNum(r.IMWB_GROSS_WT) + "</td>" +
                "<td class='num-col'>" + formatNum(r.IMWB_TARE_WT) + "</td>" +
                "<td class='num-col'><strong>" + formatNum(r.IMWB_NET_WT) + "</strong></td>" +
                "<td class='num-col' style='color:" + diffColor + "'><strong>" + (diff !== null ? ((diff > 0 ? "+" : "") + formatNum(diff)) : "-") + "</strong></td>" +
                "<td class='tabular'>" + (r.STATIC_RECORD_TIME || "-") + "</td>" +
                "<td><span class='status-badge status-" + r.MATCH_STATUS + "'>" + (r.MATCH_STATUS || "-") + "</span></td>" +
                "</tr>";
        }
        el.tableBody.innerHTML = html;

        // Pagination Labels & State
        if (el.tablePaginationInfo) {
            el.tablePaginationInfo.textContent = "Showing " + (startIdx + 1) + " to " + endIdx + " of " + rows.length;
        }
        if (el.btnPrevPage) el.btnPrevPage.disabled = state.currentPage <= 1;
        if (el.btnNextPage) el.btnNextPage.disabled = state.currentPage >= totalPages;
        if (el.paginationPages) el.paginationPages.textContent = "Page " + state.currentPage + " / " + totalPages;
    }

    // Export Modal Dialog Logic (Section 17 & 18)
    function initExportModal() {
        if (!el.btnOpenExport || !el.exportModal) return;

        function updateExportSummary() {
            var scope = el.exportScopeSelect.value;
            var area = el.exportAreaSelect.value === "current" ? state.area : el.exportAreaSelect.value;
            if (el.exportSummaryArea) el.exportSummaryArea.textContent = area;

            var estRows = state.tableRows.length;
            if (scope === "current_view") {
                estRows = state.filteredRows.length;
                if (el.exportSummaryRange) el.exportSummaryRange.textContent = "Current table view (" + state.days + " days)";
            } else if (scope === "current_day") {
                if (el.exportSummaryRange) el.exportSummaryRange.textContent = "Current Production Day";
            } else if (scope === "custom") {
                var f = el.exportFromDate.value || "Start";
                var t = el.exportToDate.value || "End";
                if (el.exportSummaryRange) el.exportSummaryRange.textContent = f + " to " + t;
            } else if (scope === "all") {
                if (el.exportSummaryRange) el.exportSummaryRange.textContent = "All Available History";
            } else {
                if (el.exportSummaryRange) el.exportSummaryRange.textContent = scope.replace("_", " ");
            }

            var filterKeys = Object.keys(state.activeColumnFilters);
            var fSummary = state.globalSearch ? "Search: " + state.globalSearch : "";
            if (filterKeys.length > 0) {
                fSummary += (fSummary ? ", " : "") + filterKeys.map(function (k) { return k + "=" + state.activeColumnFilters[k]; }).join("; ");
            }
            if (el.exportSummaryFilters) el.exportSummaryFilters.textContent = fSummary || "None";
            if (el.exportSummaryRows) el.exportSummaryRows.textContent = estRows;
        }

        el.btnOpenExport.addEventListener("click", function () {
            el.exportModal.style.display = "flex";
            updateExportSummary();
        });

        var closeFn = function () { el.exportModal.style.display = "none"; };
        if (el.btnCloseExport) el.btnCloseExport.addEventListener("click", closeFn);
        if (el.btnCancelExport) el.btnCancelExport.addEventListener("click", closeFn);

        el.exportScopeSelect.addEventListener("change", function () {
            if (el.exportCustomRange) {
                el.exportCustomRange.style.display = this.value === "custom" ? "grid" : "none";
            }
            updateExportSummary();
        });

        el.exportAreaSelect.addEventListener("change", updateExportSummary);
        if (el.exportFromDate) el.exportFromDate.addEventListener("change", updateExportSummary);
        if (el.exportToDate) el.exportToDate.addEventListener("change", updateExportSummary);

        el.btnConfirmExport.addEventListener("click", function () {
            var payload = {
                scope: el.exportScopeSelect.value,
                area: el.exportAreaSelect.value === "current" ? state.area : el.exportAreaSelect.value,
                format: el.exportFormatSelect.value,
                from_date: el.exportFromDate ? el.exportFromDate.value : null,
                to_date: el.exportToDate ? el.exportToDate.value : null,
                filters: state.activeColumnFilters,
                visible_rows: el.exportScopeSelect.value === "current_view" ? state.filteredRows : null
            };

            fetch("/api/export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            })
                .then(function (res) {
                    if (!res.ok) throw new Error("Export generation failed");
                    return res.blob();
                })
                .then(function (blob) {
                    var downloadUrl = window.URL.createObjectURL(blob);
                    var a = document.createElement("a");
                    a.href = downloadUrl;
                    var ext = payload.format === "csv" ? "csv" : "xlsx";
                    a.download = "IMWB_Weighbridge_Report_" + new Date().toISOString().slice(0, 10) + "." + ext;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    window.URL.revokeObjectURL(downloadUrl);
                    closeFn();
                })
                .catch(function (err) {
                    alert("Export error: " + err.message);
                });
        });
    }

    // Insights Page Logic (Sections 19, 20, 21, 22, 23)
    function loadInsightsData() {
        if (!el.insightsDateSelect) return;
        var area = el.insightsAreaSelect ? el.insightsAreaSelect.value : "ALL";
        var dateVal = el.insightsDateSelect.value;

        var url = "/api/insights?area=" + encodeURIComponent(area) +
            (dateVal ? "&production_date=" + encodeURIComponent(dateVal) : "");

        fetch(url)
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (el.insightsDateSelect && !el.insightsDateSelect.value) {
                    el.insightsDateSelect.value = data.production_date;
                }
                if (el.insightsWindowDisplay) {
                    el.insightsWindowDisplay.textContent = data.production_window.start + " → " + data.production_window.end + " IST";
                }

                // Render Shift Cards (C, A, B)
                for (var i = 0; i < data.shift_cards.length; i++) {
                    var sc = data.shift_cards[i];
                    var pfx = "shift-" + sc.shift.toLowerCase() + "-";
                    setText(pfx + "records", sc.total_records);
                    setText(pfx + "matched", sc.complete_matched);
                    setText(pfx + "static-net", formatNum(sc.static_net_total) + " MT");
                    setText(pfx + "imwb-net", formatNum(sc.imwb_net_total) + " MT");
                    setText(pfx + "delta", (sc.total_signed_delta > 0 ? "+" : "") + formatNum(sc.total_signed_delta) + " MT");
                    setText(pfx + "mean", (sc.mean_delta > 0 ? "+" : "") + formatNum(sc.mean_delta) + " MT");
                }

                // Render 16 Statistical Metrics
                var st = data.statistics;
                setText("stat-count", st.count);
                setText("stat-mean", (st.mean > 0 ? "+" : "") + formatNum(st.mean) + " MT");
                setText("stat-median", (st.median > 0 ? "+" : "") + formatNum(st.median) + " MT");
                setText("stat-mode", (st.mode > 0 ? "+" : "") + formatNum(st.mode) + " MT");
                setText("stat-stdev", formatNum(st.stdev) + " MT");
                setText("stat-q1", (st.q1 > 0 ? "+" : "") + formatNum(st.q1) + " MT");
                setText("stat-q3", (st.q3 > 0 ? "+" : "") + formatNum(st.q3) + " MT");
                setText("stat-iqr", formatNum(st.iqr) + " MT");
                setText("stat-p90", formatNum(st.p90_abs) + " MT");
                setText("stat-min", (st.min > 0 ? "+" : "") + formatNum(st.min) + " MT");
                setText("stat-max", (st.max > 0 ? "+" : "") + formatNum(st.max) + " MT");
                setText("stat-outlier-count", st.outlier_count);
                setText("stat-outlier-rate", formatNum(st.outlier_rate) + " %");
                setText("stat-static-net-total", formatNum(st.static_net_total) + " MT");
                setText("stat-imwb-net-total", formatNum(st.imwb_net_total) + " MT");
                setText("stat-total-signed-delta", (st.total_signed_delta > 0 ? "+" : "") + formatNum(st.total_signed_delta) + " MT");

                // Shift Statistical Pivot Table
                if (el.pivotTableBody) {
                    var pHtml = "";
                    for (var p = 0; p < data.by_shift.length; p++) {
                        var row = data.by_shift[p];
                        pHtml += "<tr>" +
                            "<td><strong>Shift " + row.shift + "</strong></td>" +
                            "<td class='num-col'>" + row.trips + "</td>" +
                            "<td class='num-col'>" + formatNum(row.static_total) + "</td>" +
                            "<td class='num-col'>" + formatNum(row.imwb_total) + "</td>" +
                            "<td class='num-col'><strong>" + (row.delta_total > 0 ? "+" : "") + formatNum(row.delta_total) + "</strong></td>" +
                            "<td class='num-col'>" + (row.mean > 0 ? "+" : "") + formatNum(row.mean) + "</td>" +
                            "<td class='num-col'>" + (row.median > 0 ? "+" : "") + formatNum(row.median) + "</td>" +
                            "<td class='num-col'>" + (row.mode > 0 ? "+" : "") + formatNum(row.mode) + "</td>" +
                            "<td class='num-col'>" + formatNum(row.stdev) + "</td>" +
                            "<td class='num-col'>" + formatNum(row.iqr) + "</td>" +
                            "<td class='num-col'>" + formatNum(row.p90_abs) + "</td>" +
                            "<td class='num-col'>" + formatNum(row.outlier_pct) + "%</td>" +
                            "</tr>";
                    }
                    el.pivotTableBody.innerHTML = pHtml;
                }

                // Deterministic Operational Interpretation
                if (el.interpretationList) {
                    var iHtml = "";
                    for (var k = 0; k < data.interpretation.length; k++) {
                        iHtml += "<li>" + data.interpretation[k] + "</li>";
                    }
                    el.interpretationList.innerHTML = iHtml;
                }
            })
            .catch(function (err) {
                console.error("Insights load error:", err);
            });
    }

    // Helper functions
    function formatNum(val) {
        if (val === null || val === undefined || isNaN(val)) return "-";
        return parseFloat(val).toFixed(2);
    }

    function setText(id, text) {
        var node = document.getElementById(id);
        if (node) node.textContent = text;
    }

    // Event Bindings
    function bindEvents() {
        if (el.globalAreaSelect) {
            el.globalAreaSelect.addEventListener("change", function () {
                state.area = this.value;
                loadDashboardData();
            });
        }

        if (el.globalDateSelect) {
            el.globalDateSelect.addEventListener("change", function () {
                state.days = this.value;
                loadDashboardData();
            });
        }

        // Chart trip selector buttons
        for (var i = 0; i < el.chartButtons.length; i++) {
            el.chartButtons[i].addEventListener("click", function () {
                for (var j = 0; j < el.chartButtons.length; j++) el.chartButtons[j].classList.remove("active");
                this.classList.add("active");
                state.chartCount = this.getAttribute("data-chart-count");
                loadDashboardData();
            });
        }

        // Search and Column Filters
        if (el.tableSearch) {
            el.tableSearch.addEventListener("input", function () {
                state.globalSearch = this.value;
                state.currentPage = 1;
                applyTableFiltersAndRender();
            });
        }

        if (el.btnToggleFilters && el.tableFilterRow) {
            el.btnToggleFilters.addEventListener("click", function () {
                var isHidden = el.tableFilterRow.style.display === "none";
                el.tableFilterRow.style.display = isHidden ? "table-row" : "none";
            });
        }

        var filterInputs = document.querySelectorAll(".col-filter");
        for (var f = 0; f < filterInputs.length; f++) {
            filterInputs[f].addEventListener("input", function () {
                var c = this.getAttribute("data-col");
                state.activeColumnFilters[c] = this.value;
                state.currentPage = 1;
                applyTableFiltersAndRender();
            });
        }

        // Table Sort Headers
        var sortHeaders = document.querySelectorAll("th.sortable");
        for (var s = 0; s < sortHeaders.length; s++) {
            sortHeaders[s].addEventListener("click", function () {
                var col = this.getAttribute("data-col");
                if (state.sortCol === col) {
                    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
                } else {
                    state.sortCol = col;
                    state.sortDir = "desc";
                }
                applyTableFiltersAndRender();
            });
        }

        // Page Size
        if (el.tablePageSize) {
            el.tablePageSize.addEventListener("change", function () {
                state.pageSize = this.value;
                state.currentPage = 1;
                renderTable();
            });
        }

        // Pagination buttons
        if (el.btnPrevPage) {
            el.btnPrevPage.addEventListener("click", function () {
                if (state.currentPage > 1) {
                    state.currentPage--;
                    renderTable();
                }
            });
        }

        if (el.btnNextPage) {
            el.btnNextPage.addEventListener("click", function () {
                var pSize = state.pageSize === "all" ? state.filteredRows.length : parseInt(state.pageSize, 10);
                var total = Math.ceil(state.filteredRows.length / pSize);
                if (state.currentPage < total) {
                    state.currentPage++;
                    renderTable();
                }
            });
        }

        // Insights Selectors
        if (el.insightsAreaSelect) el.insightsAreaSelect.addEventListener("change", loadInsightsData);
        if (el.insightsDateSelect) el.insightsDateSelect.addEventListener("change", loadInsightsData);
    }

    // Health Polling
    function checkHealth() {
        fetch("/healthz")
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (el.dbStatusDot) {
                    el.dbStatusDot.style.backgroundColor = data.status === "ok" ? "#10b981" : "#ef4444";
                }
            })
            .catch(function () {
                if (el.dbStatusDot) el.dbStatusDot.style.backgroundColor = "#ef4444";
            });
    }

    // Initialization
    function init() {
        initTheme();
        initPrint();
        bindEvents();
        initExportModal();

        if (document.getElementById("card-latest-trip")) {
            loadDashboardData();
            // Polling: 5s table/kpi, 60s health
            setInterval(function () {
                if (document.visibilityState === "visible") loadDashboardData();
            }, 5000);
        }

        if (document.getElementById("card-shift-c")) {
            loadInsightsData();
            setInterval(function () {
                if (document.visibilityState === "visible") loadInsightsData();
            }, 30000);
        }

        checkHealth();
        setInterval(function () {
            if (document.visibilityState === "visible") checkHealth();
        }, 60000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();