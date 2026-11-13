/*
    CheckEXPO2027 - Script cho Adobe InDesign (khong can cai plugin)
    -----------------------------------------------------------
    - Danh sach ma PH duoc TICH HOP SAN trong script (xem muc "DANH SACH MA PH" ben duoi)
    - Quet cac anh dat (link) trong document dang mo, chi kiem tra anh co ma nam trong danh sach
    - Kiem tra 4 loi: Torimingu (cat xen, thu nghiem) / HenBai (meo ti le) / Bi de (thu nghiem) / Kich thuoc anh toi thieu
    - Click ten anh o dong ket qua -> Jump (chon + zoom) toi anh
    - Anh loi len tren cung (ten mau do), anh OK ten mau xanh; hien ~5 dong, nhieu hon thi cuon
    - Cong tac ON/OFF tu xa: doc status.txt tren GitHub (ON = chay, khac ON = khoa)

    Script duoc viet boi Anh.

    File nay luu dang UTF-8 (co BOM) de hien thi dung tieng Viet.
*/
#target indesign
#targetengine "checkPH"

(function () {

    var VERSION = "1.3.0";

    // ---- Cau hinh ----
    var BOUNDS_TOL = 0.5;          // dung sai khi so sanh toa do (pt)
    var SCALE_TOL = 0.1;           // dung sai lech scale ngang/doc (%)
    var INDEX_ZERO_IS_FRONT = true; // trong InDesign, pageItems[0] la object o tren cung
    var IGNORE_NONPRINTING = true; // bo qua object "nonprinting" khi xet bi de
    var PH_REGEX = /[A-Za-z]{2,}\d{2,}-\d{4,}/;

    // ---- Cong tac ON/OFF tu xa (GitHub) ----
    var STATUS_URL = "https://raw.githubusercontent.com/anh-bit/CheckEXPO2027/refs/heads/main/status.txt";
    var OFFLINE_GRACE_HOURS = 24;  // mat mang van dung duoc bao nhieu gio sau lan xac thuc ON gan nhat (0 = bat buoc co mang)
    var NET_TIMEOUT_SEC = 6;

    var WIDTH_TOL_MM = 0.05;       // dung sai khi so sanh chieu rong toi thieu (mm)
    var PT_TO_MM = 25.4 / 72;

    // =========================================================
    //  DANH SACH MA PH (tich hop san)
    //  - min: chieu rong toi thieu (mm); null = khong yeu cau chieu rong
    //  - seq("LH26-", 41712, 41714) -> LH26-041712, LH26-041713, LH26-041714
    //  - Muon them ma le: them vao mang codes, vd: ["LH26-050001", "LH26-050002"]
    // =========================================================
    function seq(prefix, from, to) {
        var a = [];
        for (var n = from; n <= to; n++) {
            var t = String(n);
            while (t.length < 6) t = "0" + t;
            a.push(prefix + t);
        }
        return a;
    }

    var GROUPS = [
        { min: 24,   codes: seq("LH26-", 41711, 41711) },
        { min: 14,   codes: seq("LH26-", 41712, 41714) },
        { min: 35,   codes: seq("LH26-", 41715, 41717) },
        { min: 15,   codes: seq("LH26-", 41718, 41720) },
        { min: 57,   codes: seq("LH26-", 41721, 41722) },
        { min: null, codes: seq("LH26-", 41723, 41734) },
        { min: null, codes: seq("LH26-", 43171, 43211) }
    ];

    // Dong cua so cu neu chay script lan nua
    if ($.global.__checkPHWin) {
        try { $.global.__checkPHWin.close(); } catch (e) {}
    }

    // =========================================================
    //  Tien ich
    // =========================================================
    function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }

    function extractPHCode(name) {
        if (!name) return null;
        var m = String(name).match(PH_REGEX);
        return m ? m[0] : null;
    }

    function safeId(item) {
        try { var id = item.id; return (id === undefined || id === null) ? null : id; }
        catch (e) { return null; }
    }

    function isGroup(item) {
        try { return item.constructor.name === "Group"; } catch (e) { return false; }
    }

    function getSpread(item) {
        var cur = item;
        for (var i = 0; i < 40 && cur; i++) {
            var n = "";
            try { n = cur.constructor.name; } catch (e) {}
            if (n === "Spread" || n === "MasterSpread") return cur;
            try { cur = cur.parent; } catch (e2) { return null; }
        }
        return null;
    }

    // =========================================================
    //  Dung bang tra cuu tu danh sach tich hop
    // =========================================================
    function buildCodes() {
        var map = {}, total = 0, withMin = 0;
        for (var i = 0; i < GROUPS.length; i++) {
            var g = GROUPS[i];
            for (var j = 0; j < g.codes.length; j++) {
                var c = g.codes[j];
                var key = "~" + c.toUpperCase();
                if (map[key]) continue;
                map[key] = { code: c, min: g.min };
                total++;
                if (g.min !== null) withMin++;
            }
        }
        return { map: map, total: total, withMin: withMin };
    }

    // =========================================================
    //  Kiem tra tung loi
    // =========================================================

    // Cat xen: anh vuot ra ngoai frame (hoac frame cha khong phai group)
    function isCropped(g) {
        try {
            var gb = g.geometricBounds;
            var cur = g.parent;
            for (var i = 0; i < 20 && cur; i++) {
                var cb = null;
                try { cb = cur.geometricBounds; } catch (e) {}
                if (!cb) break;
                if (!isGroup(cur)) {
                    if (gb[0] < cb[0] - BOUNDS_TOL || gb[1] < cb[1] - BOUNDS_TOL ||
                        gb[2] > cb[2] + BOUNDS_TOL || gb[3] > cb[3] + BOUNDS_TOL) return true;
                }
                try { cur = cur.parent; } catch (e2) { break; }
            }
            return false;
        } catch (e3) { return false; }
    }

    // Meo ti le: scale ngang != scale doc
    function isDistorted(g) {
        try { return Math.abs(g.horizontalScale - g.verticalScale) > SCALE_TOL; }
        catch (e) { return false; }
    }

    // Chieu rong cua anh (mm). Anh xoay 90/270 do thi lay chieu cao cua khung bao.
    function getWidthMm(g) {
        try {
            var b = g.geometricBounds;
            var w = b[3] - b[1], h = b[2] - b[0];
            var ang = 0;
            try { ang = Math.abs(g.absoluteRotationAngle) % 180; } catch (e) {}
            var useH = Math.abs(ang - 90) < 1;
            return (useH ? h : w) * PT_TO_MM;
        } catch (e2) { return null; }
    }

    // ---- Bi de ----
    function buildSpreadIndex(spread) {
        var entries = [], byId = {};

        function walk(item, layerIdx, path) {
            var valid = true;
            try { valid = item.isValid; } catch (e) { valid = false; }
            if (!item || !valid) return;

            var group = isGroup(item);
            if (!group) {
                var id = safeId(item), b = null;
                try { b = item.geometricBounds; } catch (e1) {}
                if (id !== null && b) {
                    var en = { id: id, item: item, layer: layerIdx, path: path, bounds: b };
                    entries.push(en);
                    byId[id] = en;
                }
            } else {
                var kids = null;
                try { kids = item.pageItems; } catch (e2) {}
                if (kids) {
                    for (var k = 0; k < kids.length; k++) {
                        walk(kids[k], layerIdx, path.concat([k]));
                    }
                }
            }
        }

        var top = null;
        try { top = spread.pageItems; } catch (e) {}
        if (top) {
            for (var i = 0; i < top.length; i++) {
                var li = 0;
                try { li = top[i].itemLayer.index; } catch (e3) {}
                walk(top[i], li, [i]);
            }
        }
        return { entries: entries, byId: byId };
    }

    // a co nam tren b khong
    function isAbove(a, b) {
        if (a.layer !== b.layer) return a.layer < b.layer;
        var n = Math.min(a.path.length, b.path.length);
        for (var i = 0; i < n; i++) {
            if (a.path[i] !== b.path[i]) {
                return INDEX_ZERO_IS_FRONT ? (a.path[i] < b.path[i]) : (a.path[i] > b.path[i]);
            }
        }
        return false;
    }

    function hasVisibleContent(item) {
        try { if (item.transparencySettings.blendingSettings.opacity === 0) return false; } catch (e0) {}
        try {
            var fc = item.fillColor;
            if (fc && fc.name !== "None" && item.fillTint !== 0) return true;
        } catch (e1) {}
        try {
            var sc = item.strokeColor;
            if (sc && sc.name !== "None" && item.strokeWeight > 0) return true;
        } catch (e2) {}
        try { if (item.allGraphics.length > 0) return true; } catch (e3) {}
        try {
            if (typeof item.contents === "string" && item.contents.replace(/\s/g, "").length > 0) return true;
        } catch (e4) {}
        return false;
    }

    function isRealObstacle(en) {
        if (en.real !== undefined) return en.real;
        var ok = false;
        try {
            var it = en.item;
            ok = (it.visible !== false);
            if (ok) {
                var ly = it.itemLayer;
                if (ly && ly.visible === false) ok = false;
            }
            if (ok && IGNORE_NONPRINTING && it.nonprinting === true) ok = false;
            if (ok) ok = hasVisibleContent(it);
        } catch (e) { ok = false; }
        en.real = ok;
        return ok;
    }

    function boundsOverlap(a, b) {
        var h = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        var w = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        return h > BOUNDS_TOL && w > BOUNDS_TOL;
    }

    function isOverlapped(frame, index) {
        try {
            var id = safeId(frame);
            if (id === null) return false;
            var self = index.byId[id];
            if (!self) return false;
            for (var i = 0; i < index.entries.length; i++) {
                var o = index.entries[i];
                if (o === self) continue;
                if (!isAbove(o, self)) continue;
                if (!boundsOverlap(self.bounds, o.bounds)) continue;
                if (!isRealObstacle(o)) continue;
                return true;
            }
            return false;
        } catch (e) { return false; }
    }

    // =========================================================
    //  Quet document
    // =========================================================
    function scanDocument(doc, codes) {
        var oldUnit, oldOrigin;
        try { oldUnit = app.scriptPreferences.measurementUnit; } catch (e) {}
        try { oldOrigin = doc.viewPreferences.rulerOrigin; } catch (e2) {}
        try {
            app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
            doc.viewPreferences.rulerOrigin = RulerOrigin.SPREAD_ORIGIN;
        } catch (e3) {}

        var results = [], found = {}, spreadCache = {};
        try {
            var gs = doc.allGraphics;
            for (var i = 0; i < gs.length; i++) {
                var g = gs[i], name = null;
                try {
                    if (!g.itemLink) continue;
                    name = g.itemLink.name;
                } catch (e4) { continue; }

                var code = extractPHCode(name);
                if (!code) continue;
                var key = "~" + code.toUpperCase();
                var info = codes[key];
                if (!info) continue;
                found[key] = true;

                var frame = g.parent;
                var overlapped = false;
                var sp = getSpread(frame);
                if (sp) {
                    var sid = safeId(sp);
                    var idx = (sid !== null) ? spreadCache[sid] : null;
                    if (!idx) {
                        idx = buildSpreadIndex(sp);
                        if (sid !== null) spreadCache[sid] = idx;
                    }
                    overlapped = isOverlapped(frame, idx);
                }

                var widthMm = getWidthMm(g);
                var minMm = info.min;
                var tooSmall = (minMm !== null && widthMm !== null && widthMm < minMm - WIDTH_TOL_MM);

                results.push({
                    code: code,
                    linkName: name,
                    widthMm: widthMm,
                    minMm: minMm,
                    tooSmall: tooSmall,
                    cropped: isCropped(g),
                    distorted: isDistorted(g),
                    overlapped: overlapped,
                    frame: frame
                });
            }
        } finally {
            try { if (oldUnit !== undefined) app.scriptPreferences.measurementUnit = oldUnit; } catch (e5) {}
            try { if (oldOrigin !== undefined) doc.viewPreferences.rulerOrigin = oldOrigin; } catch (e6) {}
        }

        results.sort(function (a, b) {
            if (a.code < b.code) return -1;
            if (a.code > b.code) return 1;
            return 0;
        });

        var missing = [];
        for (var k in codes) {
            if (codes.hasOwnProperty(k) && !found[k]) missing.push(codes[k].code);
        }
        missing.sort();

        return { results: results, missing: missing };
    }

    // =========================================================
    //  Chon + zoom toi anh
    // =========================================================
    function goToItem(r) {
        try {
            var frame = r.frame;
            if (!frame || !frame.isValid) {
                alert("Đối tượng không còn tồn tại. Hãy bấm kiểm tra lại.");
                return;
            }
            var w = app.activeWindow;
            var sp = getSpread(frame);
            if (sp) { try { w.activeSpread = sp; } catch (e0) {} }

            app.select(frame, SelectionOptions.REPLACE_WITH);

            var zoomed = false;
            try {
                var m = app.menuActions.itemByName("Fit Selection in Window");
                if (m && m.isValid && m.enabled) { m.invoke(); zoomed = true; }
            } catch (e1) {}
            if (!zoomed) {
                try { w.zoomPercentage = 300; zoomed = true; } catch (e2) {}
            }
            if (!zoomed) { try { w.zoom(ZoomOptions.FIT_PAGE); } catch (e3) {} }
        } catch (e) {
            alert("Không thể di chuyển: " + e.message);
        }
    }

    var CODES = buildCodes();

    // =========================================================
    //  Giao dien (ScriptUI palette)
    // =========================================================
    // =========================================================
    //  Xac thuc ON/OFF tu GitHub
    //  status.txt: dong 1 = ON  -> cho chay
    //              khac ON      -> khoa (dong 2 tro di = loi nhan hien tren man hinh)
    // =========================================================
    var LAST_OK = new File(Folder.userData + "/CheckPH_lastok.txt");

    function fetchStatus() {
        var url = STATUS_URL + "?t=" + new Date().getTime();
        var out = null;

        if ($.os.indexOf("Mac") >= 0) {
            try {
                out = app.doScript(
                    'return do shell script "curl -fsSL -m ' + NET_TIMEOUT_SEC +
                    " -H 'Cache-Control: no-cache' '" + url + "'\"",
                    ScriptLanguage.APPLESCRIPT_LANGUAGE);
            } catch (e) { out = null; }
        } else {
            var tmp = new File(Folder.temp + "/checkph_status.txt");
            try { if (tmp.exists) tmp.remove(); } catch (e0) {}

            // Cach 1: VBScript (khong hien cua so)
            try {
                var vbs =
                    'On Error Resume Next\n' +
                    'Dim h, fso, f\n' +
                    'Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")\n' +
                    'h.setTimeouts 5000, 5000, 5000, ' + (NET_TIMEOUT_SEC * 1000) + '\n' +
                    'h.open "GET", "' + url + '", False\n' +
                    'h.setRequestHeader "Cache-Control", "no-cache"\n' +
                    'h.send\n' +
                    'If Err.Number = 0 And h.Status = 200 Then\n' +
                    '  Set fso = CreateObject("Scripting.FileSystemObject")\n' +
                    '  Set f = fso.CreateTextFile("' + tmp.fsName + '", True)\n' +
                    '  f.Write h.responseText\n' +
                    '  f.Close\n' +
                    'End If\n';
                app.doScript(vbs, ScriptLanguage.VISUAL_BASIC);
            } catch (e1) {}

            try {
                if (tmp.exists) {
                    tmp.encoding = "UTF-8";
                    if (tmp.open("r")) { out = tmp.read(); tmp.close(); }
                    tmp.remove();
                }
            } catch (e2) {}

            // Cach 2: curl.exe (Windows 10+)
            if (out === null || !trim(String(out)).length) {
                try { out = system.callSystem('curl.exe -fsSL -m ' + NET_TIMEOUT_SEC + ' "' + url + '"'); }
                catch (e3) { out = null; }
            }
        }

        if (out === null || out === undefined) return null;
        out = String(out).replace(/^\uFEFF/, "");
        if (!trim(out).length) return null;
        return out;
    }

    function saveLastOk() {
        try {
            LAST_OK.encoding = "UTF-8";
            if (LAST_OK.open("w")) { LAST_OK.write(String(new Date().getTime())); LAST_OK.close(); }
        } catch (e) {}
    }
    function loadLastOk() {
        try {
            if (!LAST_OK.exists) return 0;
            LAST_OK.encoding = "UTF-8";
            LAST_OK.open("r");
            var v = parseInt(trim(LAST_OK.read()), 10);
            LAST_OK.close();
            return isNaN(v) ? 0 : v;
        } catch (e) { return 0; }
    }

    // return { ok:Boolean, offline:Boolean, msg:String }
    function checkLicense() {
        var raw = fetchStatus();
        if (raw !== null) {
            var lines = raw.split(/\r\n|\r|\n/);
            var first = trim(lines[0]).toUpperCase();
            if (first === "ON") {
                saveLastOk();
                return { ok: true, offline: false, msg: "" };
            }
            var extra = trim(lines.slice(1).join(" "));
            return { ok: false, offline: false, msg: extra.length ? extra : "Script đang tạm khoá (OFF)." };
        }
        // Khong ket noi duoc
        var last = loadLastOk();
        var limit = OFFLINE_GRACE_HOURS * 3600 * 1000;
        var age = new Date().getTime() - last;
        if (limit > 0 && last > 0 && age >= 0 && age < limit) {
            var hrs = Math.ceil((limit - age) / 3600000);
            return { ok: true, offline: true, msg: "Không kết nối được máy chủ – còn dùng được khoảng " + hrs + " giờ." };
        }
        return { ok: false, offline: false, msg: "Cần kết nối mạng để xác thực script. Vui lòng kiểm tra kết nối." };
    }

    // =========================================================
    //  Giao dien (ScriptUI palette)
    // =========================================================
    var GREEN = [0.13, 0.62, 0.30, 1];
    var RED   = [0.86, 0.18, 0.18, 1];
    var AMBER = [0.92, 0.62, 0.15, 1];
    var GRAY  = [0.55, 0.55, 0.55, 1];

    function colorize(st, rgb) {
        try { st.graphics.foregroundColor = st.graphics.newPen(st.graphics.PenType.SOLID_COLOR, rgb, 1); } catch (e) {}
    }
    // style: "BOLD" hoac "REGULAR"
    function setFont(st, style, size) {
        var fs = (String(style).toUpperCase() === "BOLD") ? ScriptUI.FontStyle.BOLD : ScriptUI.FontStyle.REGULAR;
        try { st.graphics.font = ScriptUI.newFont("Arial", fs, size); return; } catch (e) {}
        try { st.graphics.font = ScriptUI.newFont("dialog", fs, size); } catch (e2) {}
    }
    function separator(parent) {
        var p = parent.add("panel");
        p.alignment = ["fill", "top"];
        p.preferredSize.height = 1;
        return p;
    }

    var W = 470; // chieu rong noi dung
    var LIST_HEIGHT = 135; // ~5 dong + tieu de cot; nhieu hon se tu hien thanh cuon

    var win = new Window("palette", "CheckEXPO2027-v" + VERSION + "-ByAnh", undefined, { resizeable: true });
    $.global.__checkPHWin = win;
    win.orientation = "column";
    win.alignChildren = ["fill", "top"];
    win.margins = [14, 10, 14, 8];
    win.spacing = 7;

    // --- Tieu de + trang thai kich hoat ---
    var head = win.add("group");
    head.orientation = "row";
    head.alignment = ["fill", "top"];
    head.alignChildren = ["left", "center"];
    var title = head.add("statictext", undefined, "CHECK EXPO 2027");
    setFont(title, "BOLD", 18);
    var headSpacer = head.add("group");
    headSpacer.alignment = ["fill", "fill"];
    var badge = head.add("statictext", undefined, "\u25CF Đang xác thực...", { justify: "right" });
    badge.preferredSize.width = 170;
    setFont(badge, "BOLD", 12);
    colorize(badge, GRAY);

    var infoTxt = win.add("statictext", undefined,
        "Danh sách tích hợp: " + CODES.total + " mã  ·  " + CODES.withMin + " mã có yêu cầu kích thước tối thiểu",
        { truncate: "end" });
    infoTxt.preferredSize.width = W;
    setFont(infoTxt, "REGULAR", 11);
    colorize(infoTxt, GRAY);

    separator(win);

    // --- Khung ket qua ---
    var pnl = win.add("panel", undefined, "Kết quả kiểm tra");
    pnl.orientation = "column";
    pnl.alignment = ["fill", "top"];
    pnl.alignChildren = ["fill", "top"];
    pnl.margins = [10, 16, 10, 8];
    pnl.spacing = 6;

    var rowTop = pnl.add("group");
    rowTop.orientation = "row";
    rowTop.alignment = ["fill", "top"];
    rowTop.alignChildren = ["left", "center"];
    rowTop.spacing = 10;
    var cTotal = rowTop.add("statictext", undefined, "Tổng: –");
    var cErr   = rowTop.add("statictext", undefined, "Lỗi: –");
    cTotal.preferredSize.width = 120;
    cErr.preferredSize.width = 90;
    setFont(cTotal, "BOLD", 13);
    setFont(cErr, "BOLD", 13);
    var rowSpacer = rowTop.add("group");
    rowSpacer.alignment = ["fill", "fill"];
    var chkOnlyErr = rowTop.add("checkbox", undefined, "Chỉ hiện ảnh lỗi");

    // --- Bang ket qua: ve tuy chinh (ten anh co mau), co thanh cuon ---
    var HEAD_TITLES = ["Tên Ảnh", "Torimingu", "HenBai", "Bị đè", "Kích thước ảnh tối thiểu"];
    var COLS = [100, 78, 58, 52, 150];
    var ROW_H = 22;
    var VIEW_ROWS = 5;
    var VIEW_W = COLS[0] + COLS[1] + COLS[2] + COLS[3] + COLS[4];
    var VIEW_H = ROW_H * (VIEW_ROWS + 1);

    var results = [];     // toan bo ket qua
    var shown = [];       // ket qua dang hien thi (loi o tren cung)
    var scrollPos = 0;    // dong dau tien dang thay
    var selIdx = -1;      // dong dang chon
    var useCustom = true; // false -> chuyen sang listbox mac dinh neu khong ve tuy chinh duoc
    var viewDrawn = false;
    var nativeList = null;

    var listWrap = pnl.add("group");
    listWrap.orientation = "row";
    listWrap.spacing = 2;
    listWrap.alignment = ["fill", "top"];
    listWrap.alignChildren = ["left", "top"];

    var view = listWrap.add("group");
    view.preferredSize = [VIEW_W, VIEW_H];
    view.minimumSize = [VIEW_W, VIEW_H];
    view.maximumSize = [VIEW_W, VIEW_H];

    var sb = listWrap.add("scrollbar", undefined, 0, 0, 1);
    sb.preferredSize = [18, VIEW_H];
    sb.stepdelta = 1;
    sb.jumpdelta = VIEW_ROWS;
    sb.enabled = false;
    var note = pnl.add("statictext", undefined, "Click tên ảnh để Jump tới ảnh");
    setFont(note, "REGULAR", 10);
    colorize(note, GRAY);

    // --- Thong bao + nut Check EXPO (duoi bang) ---
    var statusTxt = win.add("statictext", undefined, "Mở file INDD rồi bấm \"Check EXPO\".", { truncate: "end" });
    statusTxt.preferredSize.width = W;
    setFont(statusTxt, "REGULAR", 11);
    colorize(statusTxt, GRAY);

    var btnRun = win.add("button", undefined, "Check EXPO");
    btnRun.preferredSize.height = 34;
    setFont(btnRun, "BOLD", 14);
    btnRun.enabled = false;

    separator(win);

    // --- Chan trang ---
    var footer = win.add("statictext", undefined, "Script được viết bởi Anh  ·  v" + VERSION, { justify: "center" });
    footer.alignment = ["fill", "bottom"];
    setFont(footer, "REGULAR", 10);
    colorize(footer, GRAY);

    function mark(bad) { return bad ? "\u2715" : "OK"; }

    function widthCell(r) {
        if (r.minMm === null) return "\u2014";
        if (r.widthMm === null) return "?";
        return mark(r.tooSmall) + " " + r.widthMm.toFixed(1) + " / " + r.minMm + " mm";
    }

    function setCounters(total, err) {
        if (total === null) {
            cTotal.text = "Tổng: –"; cErr.text = "Lỗi: –";
            colorize(cTotal, GRAY); colorize(cErr, GRAY);
        } else {
            cTotal.text = "Tổng: " + total + " ảnh";
            cErr.text = "Lỗi: " + err;
            colorize(cTotal, GRAY);
            colorize(cErr, err > 0 ? RED : GREEN);
        }
        try { rowTop.layout.layout(true); } catch (e) {}
    }

    function rowBad(r) { return !!(r.cropped || r.distorted || r.overlapped || r.tooSmall); }

    function drawPen(g, rgb) { return g.newPen(g.PenType.SOLID_COLOR, rgb, 1); }
    function drawBrush(g, rgb) { return g.newBrush(g.BrushType.SOLID_COLOR, rgb); }

    view.onDraw = function () {
        viewDrawn = true;
        try {
            var g = this.graphics, w = this.size.width;
            var fB = ScriptUI.newFont("Arial", ScriptUI.FontStyle.BOLD, 12);
            var fR = ScriptUI.newFont("Arial", ScriptUI.FontStyle.REGULAR, 12);
            var i, k, x;

            // tieu de cot
            x = 8;
            for (k = 0; k < HEAD_TITLES.length; k++) {
                g.drawString(HEAD_TITLES[k], drawPen(g, GRAY), x, 4, fB);
                x += COLS[k];
            }
            g.newPath(); g.rectPath(0, ROW_H - 1, w, 1);
            g.fillPath(drawBrush(g, [0.5, 0.5, 0.5, 0.6]));

            // cac dong
            for (i = 0; i < VIEW_ROWS; i++) {
                var idx = scrollPos + i;
                if (idx >= shown.length) break;
                var r = shown[idx], y = ROW_H * (i + 1);

                if (idx === selIdx) {
                    g.newPath(); g.rectPath(0, y, w, ROW_H);
                    g.fillPath(drawBrush(g, [0.30, 0.50, 0.90, 0.30]));
                }

                // ten anh: do = co loi, xanh = OK
                x = 8;
                g.drawString(r.code, drawPen(g, rowBad(r) ? RED : GREEN), x, y + 4, fB);
                x += COLS[0];

                var flags = [r.cropped, r.distorted, r.overlapped];
                for (k = 0; k < 3; k++) {
                    g.drawString(mark(flags[k]), drawPen(g, flags[k] ? RED : GREEN), x, y + 4, fR);
                    x += COLS[k + 1];
                }
                var wRgb = (r.minMm === null) ? GRAY : (r.tooSmall ? RED : GREEN);
                g.drawString(widthCell(r), drawPen(g, wRgb), x, y + 4, fR);
            }
        } catch (e) {}
    };

    function redraw() {
        try { view.visible = false; view.visible = true; } catch (e) {}
        try { listWrap.layout.layout(true); } catch (e2) {}
    }

    function updateScroll() {
        var maxv = Math.max(0, shown.length - VIEW_ROWS);
        if (scrollPos > maxv) scrollPos = maxv;
        try {
            sb.minvalue = 0;
            sb.maxvalue = Math.max(1, maxv);
            sb.value = scrollPos;
            sb.enabled = maxv > 0;
        } catch (e) {}
    }

    sb.onChanging = sb.onChange = function () {
        scrollPos = Math.round(sb.value);
        redraw();
    };

    view.addEventListener("mousedown", function (ev) {
        try {
            var y = ev.clientY;
            if (y > view.size.height) { y -= view.windowBounds.top; } // phong khi toa do tinh theo cua so
            var row = Math.floor(y / ROW_H) - 1;
            if (row < 0 || row >= VIEW_ROWS) return;
            var idx = scrollPos + row;
            if (idx >= shown.length) return;
            selIdx = idx;
            redraw();
            goToItem(shown[idx]);
        } catch (e) {}
    });

    // ---- Phuong an du phong: listbox mac dinh (khong co mau chu) ----
    function fillNative() {
        if (!nativeList) return;
        nativeList.removeAll();
        for (var i = 0; i < shown.length; i++) {
            var r = shown[i];
            var dot = rowBad(r) ? "\uD83D\uDD34 " : "\uD83D\uDFE2 ";
            var it = nativeList.add("item", dot + r.code);
            it.subItems[0].text = mark(r.cropped);
            it.subItems[1].text = mark(r.distorted);
            it.subItems[2].text = mark(r.overlapped);
            it.subItems[3].text = widthCell(r);
        }
    }

    function switchToFallback() {
        if (!useCustom) return;
        useCustom = false;
        try {
            listWrap.visible = false;
            listWrap.preferredSize = [0, 0];
            listWrap.minimumSize = [0, 0];
            listWrap.maximumSize = [0, 0];
        } catch (e) {}
        nativeList = pnl.add("listbox", undefined, [], {
            numberOfColumns: 5, showHeaders: true,
            columnTitles: HEAD_TITLES, columnWidths: COLS
        });
        nativeList.alignment = ["fill", "top"];
        nativeList.preferredSize = [W, LIST_HEIGHT];
        nativeList.minimumSize = [W, LIST_HEIGHT];
        nativeList.maximumSize = [2000, LIST_HEIGHT];
        try { nativeList.moveBefore(note); } catch (e2) {}
        nativeList.onChange = nativeList.onDoubleClick = function () {
            if (nativeList.selection !== null && nativeList.selection !== undefined) {
                goToItem(shown[nativeList.selection.index]);
            }
        };
        try { pnl.layout.layout(true); win.layout.layout(true); } catch (e3) {}
        fillNative();
    }

    function refreshList() {
        if (useCustom) { updateScroll(); redraw(); }
        else { fillNative(); }
    }

    function clearList() {
        shown = []; scrollPos = 0; selIdx = -1;
        refreshList();
    }

    // Loi len tren cung, sau do toi cac anh OK (moi nhom theo ma PH)
    function render() {
        var errs = [], oks = [];
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (rowBad(r)) errs.push(r);
            else if (!chkOnlyErr.value) oks.push(r);
        }
        shown = errs.concat(oks);
        scrollPos = 0;
        selIdx = -1;
        refreshList();
    }

    function setStatus(text, rgb) {
        statusTxt.text = text;
        colorize(statusTxt, rgb || GRAY);
    }

    function applyLicense(lic) {
        if (lic.ok) {
            if (lic.offline) {
                badge.text = "\u25CF Ngoại tuyến";
                colorize(badge, AMBER);
                setStatus(lic.msg, AMBER);
            } else {
                badge.text = "\u25CF Đã kích hoạt";
                colorize(badge, GREEN);
            }
            btnRun.enabled = true;
        } else {
            badge.text = "\u25CF Đã khoá";
            colorize(badge, RED);
            btnRun.enabled = false;
            results = [];
            clearList();
            setCounters(null);
            setStatus(lic.msg, RED);
        }
        try { win.update(); } catch (e) {}
    }

    btnRun.onClick = function () {
        if (app.documents.length === 0) { alert("Chưa có document nào đang mở."); return; }

        btnRun.enabled = false;
        setStatus("Đang xác thực...", GRAY);
        try { win.update(); } catch (e0) {}

        var lic = checkLicense();
        applyLicense(lic);
        if (!lic.ok) return;

        btnRun.enabled = false;
        setStatus("Đang kiểm tra...", GRAY);
        try { win.update(); } catch (e1) {}
        try {
            var out = scanDocument(app.activeDocument, CODES.map);
            results = out.results;
            render();

            var errCount = 0;
            for (var i = 0; i < results.length; i++) {
                var q = results[i];
                if (q.cropped || q.distorted || q.overlapped || q.tooSmall) errCount++;
            }
            setCounters(results.length, errCount);
            if (results.length === 0) {
                setStatus("Không tìm thấy ảnh nào khớp danh sách PH trong file này.", AMBER);
            } else if (lic.offline) {
                setStatus(lic.msg, AMBER);
            } else {
                setStatus("Hoàn tất.", GREEN);
            }
        } catch (e) {
            alert("Lỗi kiểm tra: " + e.message + " (dòng " + e.line + ")");
            setStatus("", GRAY);
        } finally {
            btnRun.enabled = true;
        }
    };

    chkOnlyErr.onClick = function () { render(); };

    win.onResizing = win.onResize = function () { this.layout.resize(); };

    // Khoi tao: hien cua so truoc, sau do xac thuc
    win.center();
    win.show();
    try { win.update(); } catch (e) {}
    if (!viewDrawn) switchToFallback();   // khong ve tuy chinh duoc -> dung listbox mac dinh
    applyLicense(checkLicense());

})();
