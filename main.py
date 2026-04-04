# main.py
import sys
import os
import random
import json
import re
from datetime import datetime
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QGridLayout, QLabel, QPushButton, QMessageBox, QScrollArea,
    QSplashScreen, QSystemTrayIcon, QMenu, QFrame, QTableWidgetItem, QSizePolicy,
    QTextEdit, QDialog
)
from PySide6.QtCore import Qt, QSettings, QTimer, QDate, QTime, QRectF, QThread, Signal, QUrl
from PySide6.QtGui import QFont, QColor, QPixmap, QIcon, QPainter, QAction
from PySide6.QtNetwork import QTcpServer, QTcpSocket, QHostAddress

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWebChannel import QWebChannel
    from PySide6.QtCore import QObject, Slot
    WEB_ENGINE_AVAILABLE = True
except ImportError:
    WEB_ENGINE_AVAILABLE = False

from config import get_resource_path, PORT, CURRENT_VERSION
from data import PROJECTS_LIST, CITIES_LIST, STREETS_LIST, OFFICE_ADDRESS_MAP
from theme import THEME
from models import ROAMObservation
from workers import PersistentCopilotWorker, VoiceWorker, WorkerThread, BulkWorkerThread
from widgets import (
    CompactLineEdit, SearchableComboBox, LockableComboBox,
    CompactDateEdit, CompactTimeEdit, LabeledSwitch,
    AppleSegmentedControl, CardTypeSelector, ExcelPasteTable,
    OverlayTextEdit
)
from dialogs import LocationPromptDialog, ProgressDialog

def get_full_card_type(short_type):
    short = str(short_type).lower()
    if "design" in short:
        return "Design"
    elif "office" in short:
        return "Office"
    else:
        return "Field"


# ---------------------------------------------------------------------------
# JavaScript bridge object — receives the picked location from the web page
# ---------------------------------------------------------------------------
if WEB_ENGINE_AVAILABLE:
    class MapBridge(QObject):
        location_picked = Signal(float, float, str)  # lat, lon, address

        @Slot(float, float, str)
        def on_location_picked(self, lat, lon, address):
            self.location_picked.emit(lat, lon, address)


class MapPickerDialog(QDialog):
    """Opens an embedded Map page so the user can click to pick a location."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Choose Location on Map")
        self.resize(900, 620)
        self.picked_lat = None
        self.picked_lon = None
        self.picked_address = ""

        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(8)

        if not WEB_ENGINE_AVAILABLE:
            lbl = QLabel(
                "PySide6-WebEngine is not installed.\n"
                "Install it with:  pip install PySide6-WebEngineWidgets\n\n"
                "Without it the map picker is unavailable."
            )
            lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
            layout.addWidget(lbl)
            close_btn = QPushButton("Close")
            close_btn.clicked.connect(self.reject)
            layout.addWidget(close_btn)
            return

        info = QLabel("Click anywhere on the map to drop a pin, then press <b>Confirm Location</b>.")
        info.setWordWrap(True)
        layout.addWidget(info)

        self.web_view = QWebEngineView()
        layout.addWidget(self.web_view, stretch=1)

        btn_row = QHBoxLayout()
        self.lbl_selected = QLabel("No location selected yet.")
        self.lbl_selected.setWordWrap(True)
        btn_row.addWidget(self.lbl_selected, stretch=1)

        self.confirm_btn = QPushButton("Confirm Location")
        self.confirm_btn.setEnabled(False)
        self.confirm_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.confirm_btn.clicked.connect(self.accept)
        btn_row.addWidget(self.confirm_btn)

        cancel_btn = QPushButton("Cancel")
        cancel_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)

        layout.addLayout(btn_row)

        # Set up the web channel bridge
        self.bridge = MapBridge(self)
        self.bridge.location_picked.connect(self._on_location_picked)

        self.channel = QWebChannel(self.web_view.page())
        self.channel.registerObject("bridge", self.bridge)
        self.web_view.page().setWebChannel(self.channel)

        self._load_map()

        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def apply_theme(self, c):
        self.setStyleSheet(f"""
            QDialog {{ background-color: {c['bg']}; font-family: 'Source Sans Pro'; }}
            QLabel {{ color: {c['text']}; }}
            QPushButton {{
                padding: 6px 14px; border: 1px solid {c['border']};
                border-radius: 4px; background-color: {c['input_bg']};
                color: {c['text']}; font-weight: bold;
            }}
            QPushButton:hover {{ background-color: {c['surface_hover']}; }}
            QPushButton:disabled {{ color: {c['text_muted']}; }}
        """)

    def _load_map(self):
        """Build the HTML page with an embedded Leaflet Map and a qwebchannel.js bridge."""
        html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  body, html {{ margin:0; padding:0; height:100%; }}
  #map {{ width:100%; height:100%; }}
  #info {{
    position:absolute; top:10px; left:50%; transform:translateX(-50%);
    background:rgba(0,0,0,0.65); color:#fff; padding:6px 14px;
    border-radius:20px; font-family:sans-serif; font-size:13px;
    pointer-events:none; z-index:999;
  }}
  #search-box {{
    position:absolute; bottom:20px; left:50%; transform:translateX(-50%);
    z-index:999; display:flex; gap: 4px;
  }}
  #search-input {{
    padding: 6px; border: 1px solid #ccc; border-radius: 4px; font-family:sans-serif; width: 250px;
  }}
  #search-btn {{
    padding: 6px 12px; background: #fff; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-family:sans-serif;
  }}
</style>
</head>
<body>
<div id="info">Click anywhere on the map to place a pin</div>
<div id="search-box">
  <input type="text" id="search-input" placeholder="Search address...">
  <button id="search-btn" onclick="searchAddress()">Search</button>
</div>
<div id="map"></div>

<!-- QWebChannel bootstrap -->
<script src="qrc:///qtwebchannel/qwebchannel.js"></script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<script>
var bridge = null;
var map = null;
var marker = null;

// Initialise the Qt web channel
new QWebChannel(qt.webChannelTransport, function(channel) {{
    bridge = channel.objects.bridge;
}});

function searchAddress() {{
    var q = document.getElementById('search-input').value;
    if(!q) return;
    fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(q))
        .then(function(r) {{ return r.json(); }})
        .then(function(data) {{
            if(data && data.length > 0) {{
                var lat = parseFloat(data[0].lat);
                var lon = parseFloat(data[0].lon);
                map.setView([lat, lon], 14);
            }}
        }});
}}

function initMap() {{
    map = L.map('map').setView([0, 0], 2);

    L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }}).addTo(map);

    // Try to center map based on IP location
    fetch('https://get.geojs.io/v1/ip/geo.json')
        .then(function(response) {{ return response.json(); }})
        .then(function(data) {{
            if (data && data.latitude && data.longitude) {{
                map.setView([data.latitude, data.longitude], 13);
            }}
        }})
        .catch(function() {{ console.log("IP geolocation failed, using default view"); }});

    map.on('click', function(e) {{
        var lat = e.latlng.lat;
        var lon = e.latlng.lng;

        if (marker) {{
            marker.setLatLng(e.latlng);
        }} else {{
            marker = L.marker(e.latlng).addTo(map);
        }}

        document.getElementById('info').textContent =
            'Pin placed at ' + lat.toFixed(5) + ', ' + lon.toFixed(5) + ' — reverse-geocoding...';

        // Reverse geocode via Nominatim REST API
        var url = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lon;

        fetch(url)
            .then(function(r) {{ return r.json(); }})
            .then(function(data) {{
                var address = data.display_name;
                if (!address) address = lat.toFixed(5) + ', ' + lon.toFixed(5);

                document.getElementById('info').textContent = 'Selected: ' + address;

                if (bridge) {{
                    bridge.on_location_picked(lat, lon, address);
                }}
            }})
            .catch(function() {{
                var fallback = lat.toFixed(5) + ', ' + lon.toFixed(5);
                document.getElementById('info').textContent = 'Selected: ' + fallback;
                if (bridge) {{
                    bridge.on_location_picked(lat, lon, fallback);
                }}
            }});
    }});
}}

// Trigger search on enter key
document.getElementById('search-input').addEventListener('keypress', function(e) {{
    if (e.key === 'Enter') {{
        searchAddress();
    }}
}});

window.onload = initMap;
</script>
</body>
</html>"""
        self.web_view.setHtml(html, QUrl("http://localhost/"))

    def _on_location_picked(self, lat, lon, address):
        self.picked_lat = lat
        self.picked_lon = lon
        self.picked_address = address
        self.lbl_selected.setText(f"📍 {address}")
        self.confirm_btn.setEnabled(True)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.settings = QSettings("ROAMHelper", "Settings")
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

        screen = QApplication.primaryScreen().availableGeometry()
        target_height = min(965, screen.height() - 60)

        self.setGeometry(100, 100, 680, target_height + 10)
        self.setMinimumSize(530, 1035)

        self.ai_state = "EDIT"
        self.ai_prompt_text = ""
        self.extracted_data = None
        self.is_recording = False
        self.voice_worker = None
        self.cancel_copilot = False
        self.location_retried = False
        self.worker = None
        # Stores the map-picked address to inject into the Copilot prompt
        self._map_location_hint = ""
        
        self.debug_copilot = False
        self.debug_roam = False

        self.status_timer = QTimer(self)
        self.status_timer.timeout.connect(self.update_random_status)

        self.ai_timeout_timer = QTimer(self)
        self.ai_timeout_timer.setSingleShot(True)
        self.ai_timeout_timer.timeout.connect(self.on_ai_timeout)

        self.status_messages = [
            "Reading your observation...",
            "Looking for location details...",
            "Checking the date and time...",
            "Identifying hazards and safe behaviors...",
            "Putting it all together...",
            "Almost done..."
        ]
        self.current_status_index = 0

        self.setup_ui()
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())
        self.load_last_observation()

        self.start_preloaded_copilot()

    def start_preloaded_copilot(self):
        if hasattr(self, 'copilot_worker') and self.copilot_worker.isRunning():
            return

        self.copilot_worker = PersistentCopilotWorker(headless=not self.debug_copilot)
        self.copilot_worker.finished_signal.connect(self.on_copilot_finished)
        self.copilot_worker.start()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_D and event.modifiers() == (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.ShiftModifier | Qt.KeyboardModifier.AltModifier):
            self.show_debug_dialog()
            return
        super().keyPressEvent(event)

    def show_debug_dialog(self):
        from PySide6.QtWidgets import QDialog, QVBoxLayout, QCheckBox, QPushButton
        dlg = QDialog(self)
        dlg.setWindowTitle("Debug Options")
        layout = QVBoxLayout(dlg)
        
        cb_copilot = QCheckBox("Show Copilot Browser (Headless = False)")
        cb_copilot.setChecked(self.debug_copilot)
        layout.addWidget(cb_copilot)
        
        cb_roam = QCheckBox("Show ROAM Browser (Headless = False)")
        cb_roam.setChecked(self.debug_roam)
        layout.addWidget(cb_roam)
        
        btn = QPushButton("Apply && Restart Copilot")
        def apply():
            self.debug_copilot = cb_copilot.isChecked()
            self.debug_roam = cb_roam.isChecked()
            self.stop_copilot_browser()
            self.start_preloaded_copilot()
            dlg.accept()
        btn.clicked.connect(apply)
        layout.addWidget(btn)
        
        dlg.exec()

    def mousePressEvent(self, event):
        focused = QApplication.focusWidget()
        if focused:
            focused.clearFocus()
        super().mousePressEvent(event)

    def _set_textedit_highlight(self, widget, active):
        widget._ai_highlighted = active
        self._apply_textedit_theme(widget)

    def _apply_textedit_theme(self, widget):
        c = THEME.get_colors()
        bg = c['ai_highlight_bg'] if getattr(widget, '_ai_highlighted', False) else c['input_bg']
        widget.setStyleSheet(f"""
            QTextEdit {{
                padding: 4px 8px;
                border: 1px solid {c['border']};
                border-radius: 4px;
                background-color: {bg};
                color: {c['input_text']};
            }}
            QTextEdit:focus {{ border-color: {c['orange']}; }}
        """)

    def apply_theme(self, c):
        self.setStyleSheet(f"""
            QMainWindow, QScrollArea {{ background-color: {c['bg']}; }}
            QWidget#central_widget {{ background-color: {c['bg']}; }}
            QLabel {{ color: {c['text']}; }}
            QWidget {{ font-family: 'Source Sans Pro', Arial, sans-serif; }}
        """)

        if getattr(self.logo_label, "pixmap", lambda: None)() is None or self.logo_label.pixmap().isNull():
            self.logo_label.setStyleSheet(f"font-size: 20px; font-weight: 900; color: {c['text']}; letter-spacing: 1px;")
        else:
            self.logo_label.setStyleSheet("")

        heading_color = c['text']

        self.app_title.setStyleSheet(f"font-size: 15px; font-weight: bold; color: {heading_color};")
        self.toggles_container.setStyleSheet(f"background-color: {c['surface']}; border-radius: 8px; padding: 12px;")
        self.divider.setStyleSheet(f"background-color: {c['border']}; margin-bottom: 2px;")

        btn_style = f"""
            QPushButton {{ padding: 6px 10px; border: 1px solid {c['border']}; border-radius: 4px; background-color: {c['input_bg']}; font-weight: 600; color: {c['text']}; font-size: 11px; }}
            QPushButton:hover {{ background-color: {c['surface_hover']}; }}
        """
        self.btn_bulk_add.setStyleSheet(btn_style)
        self.btn_use_default.setStyleSheet(btn_style)
        self.btn_set_default.setStyleSheet(btn_style)
        self.btn_map.setStyleSheet(btn_style + " font-size: 16px; color: #888888;")

        self.btn_clear_all.setStyleSheet(f"""
            QPushButton {{ padding: 6px 10px; border: 1px solid {c['danger_border']}; border-radius: 4px; background-color: {c['danger_bg']}; font-weight: 600; color: {c['danger_text']}; font-size: 11px; }}
            QPushButton:hover {{ background-color: {c['danger_border']}; color: #FFFFFF; }}
        """)

        self.submit_btn.setStyleSheet(f"""
            QPushButton {{ padding: 12px 20px; border: none; border-radius: 8px; background-color: {c['primary']}; font-weight: bold; font-size: 14px; color: #FFFFFF; }}
            QPushButton:hover {{ background-color: {c['primary_hover']}; }}
            QPushButton:pressed {{ background-color: {c['primary_pressed']}; }}
        """)

        for lbl in getattr(self, 'all_headings', []):
            lbl.setStyleSheet(f"font-size: 11px; font-weight: 800; color: {heading_color};")

        self.category_combo.apply_theme(c)
        self.text_exact_loc.apply_theme(c)

        self._apply_textedit_theme(self.observation_entry)
        self._apply_textedit_theme(self.action_entry)

        self.apply_ai_theme(c)

    def apply_ai_theme(self, c):
        bg = c['ai_result_bg'] if self.ai_state == "RESULT" else c['input_bg']
        txt_color = c['input_text']
        border = c['border']

        self.ai_input.setStyleSheet(f"""
            QTextEdit {{
                background-color: {bg};
                color: {txt_color};
                border: 1px solid {border};
                border-bottom: none;
                border-top-left-radius: 8px;
                border-top-right-radius: 8px;
                border-bottom-left-radius: 0px;
                border-bottom-right-radius: 0px;
                padding: 8px;
                font-size: 14px;
                font-family: 'Source Sans Pro';
            }}
            QTextEdit:focus {{
                border-color: {c['hatch_blue']};
            }}
        """)

        if self.ai_state == "RESULT":
            html = f"""
            <div style="color: {c['text']}; padding: 15px; text-align: center; margin-top: 20px; font-family: 'Source Sans Pro'; font-size: 15px;">
                <b>Roam Observation Form Updated<br>Click Submit Observation</b>
            </div>
            """
            self.ai_input.setHtml(html)
        elif self.ai_state == "EDIT":
            cursor = self.ai_input.textCursor()
            self.ai_input.selectAll()
            self.ai_input.setTextColor(QColor(txt_color))
            self.ai_input.setTextCursor(cursor)

        btn_left_color = c['surface']
        btn_left_txt = c['text']
        if self.ai_state == "PROCESSING":
            btn_left_color = c['bg']
            btn_left_txt = c['text_muted']
        elif self.ai_state == "RESULT":
            btn_left_color = c['hatch_blue']
            btn_left_txt = "#FFFFFF"

        self.btn_ai_left.setStyleSheet(f"""
            QPushButton {{
                background-color: {btn_left_color};
                color: {btn_left_txt};
                border: 1px solid {border};
                border-right: none;
                border-top-left-radius: 0px;
                border-top-right-radius: 0px;
                border-bottom-left-radius: 8px;
                border-bottom-right-radius: 0px;
                font-weight: bold;
                font-size: 12px;
            }}
            QPushButton:hover:!disabled {{ background-color: {c['surface_hover'] if self.ai_state != "RESULT" else c['primary_hover']}; }}
        """)

        btn_right_color = c['surface']
        btn_right_txt = c['text']
        if self.ai_state == "RESULT":
            btn_right_color = c['success']
            btn_right_txt = "#FFFFFF"
        elif self.ai_state == "PROCESSING":
            btn_right_color = c['danger_bg']
            btn_right_txt = c['danger_text']

        self.btn_ai_right.setStyleSheet(f"""
            QPushButton {{
                background-color: {btn_right_color};
                color: {btn_right_txt};
                border: 1px solid {border};
                border-top-left-radius: 0px;
                border-top-right-radius: 0px;
                border-bottom-left-radius: 0px;
                border-bottom-right-radius: 8px;
                font-weight: bold;
                font-size: 12px;
            }}
            QPushButton:hover:!disabled {{ opacity: 0.8; }}
        """)

    def clear_highlights(self):
        c = THEME.get_colors()
        if hasattr(self, 'contractor_switch'):
            self.contractor_switch.set_highlight(False, "")
            self.hours_switch.set_highlight(False, "")
            self.obs_type_segmented.set_ai_highlight(False)
            self.obs_safe_segmented.set_ai_highlight(False)
            self.office_segmented.set_ai_highlight(False)
            self.card_type_selector.set_ai_highlight(False)

            if not self.project_label.is_locked():
                self.project_label.set_ai_highlight(False)
            if not self.location_label.is_locked():
                self.location_label.set_ai_highlight(False)
            if not self.office_address.is_locked():
                self.office_address.set_ai_highlight(False)
                
            self.text_exact_loc.set_ai_highlight(False)
            self.obs_date.set_ai_highlight(False)
            self.obs_time.set_ai_highlight(False)
            self.category_combo.set_ai_highlight(False)

            self._set_textedit_highlight(self.observation_entry, False)
            self._set_textedit_highlight(self.action_entry, False)

        self.apply_theme(c)

    def set_form_enabled(self, enabled):
        self.submit_btn.setEnabled(enabled)
        self.btn_clear_all.setEnabled(enabled)
        self.btn_use_default.setEnabled(enabled)
        self.btn_set_default.setEnabled(enabled)
        self.btn_bulk_add.setEnabled(enabled)

    def setup_ui(self):
        self.all_headings = []

        def _create_label(text):
            lbl = QLabel(text)
            self.all_headings.append(lbl)
            return lbl

        scroll_area = QScrollArea()
        scroll_area.setWidgetResizable(True)
        scroll_area.setFrameShape(QFrame.Shape.NoFrame)

        central = QWidget()
        central.setObjectName("central_widget")
        main = QVBoxLayout(central)
        main.setSpacing(6)
        main.setContentsMargins(16, 16, 16, 16)

        header_layout = QHBoxLayout()
        header_layout.setContentsMargins(-8, 0, 0, 0)

        self.logo_label = QLabel()
        logo_path = get_resource_path("hatch_logo.png")
        if os.path.exists(logo_path):
            pixmap = QPixmap(logo_path)
            self.logo_label.setPixmap(pixmap.scaledToHeight(28, Qt.TransformationMode.SmoothTransformation))
        else:
            self.logo_label.setText("HATCH")

        header_layout.addWidget(self.logo_label)
        header_layout.addStretch()

        self.app_title = QLabel("Roam Observation Logger")
        self.app_title.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        header_layout.addWidget(self.app_title)

        main.addLayout(header_layout)

        tight_header_group = QVBoxLayout()
        tight_header_group.setSpacing(4)

        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(6)

        self.btn_bulk_add = QPushButton("Bulk Add Observations")
        self.btn_bulk_add.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_bulk_add.clicked.connect(self.open_bulk_add)
        self.btn_bulk_add.hide()

        self.btn_use_default = QPushButton("Use Default")
        self.btn_use_default.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_use_default.clicked.connect(self.restore_defaults)

        self.btn_set_default = QPushButton("Set current as default")
        self.btn_set_default.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_set_default.clicked.connect(self.set_defaults)

        self.btn_clear_all = QPushButton("Reset Form")
        self.btn_clear_all.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_clear_all.clicked.connect(self.reset_form)

        btn_layout.addWidget(self.btn_bulk_add)
        btn_layout.addWidget(self.btn_set_default)
        btn_layout.addWidget(self.btn_use_default)
        btn_layout.addWidget(self.btn_clear_all)
        tight_header_group.addLayout(btn_layout)

        self.setup_ai_integration(tight_header_group)

        self.divider = QWidget()
        self.divider.setFixedHeight(1)
        tight_header_group.addWidget(self.divider)

        grid_layout = QGridLayout()
        grid_layout.setSpacing(4)
        grid_layout.setColumnStretch(1, 1)

        self.project_label = LockableComboBox(PROJECTS_LIST)
        self.project_label.lineEdit().setPlaceholderText("Select Project")
        self.project_label.setCurrentText("Hatch Global (Project View)")

        self.location_label = LockableComboBox(CITIES_LIST)
        self.location_label.lineEdit().setPlaceholderText("Select Office Location")
        self.location_label.setCurrentText("Johannesburg")

        self.office_address = LockableComboBox(STREETS_LIST)
        self.office_address.lineEdit().setPlaceholderText("Select Address")
        self.office_address.setCurrentText("58 Emerald Parkway Road, Greenstone Hill")

        self.text_exact_loc = CompactLineEdit()
        self.text_exact_loc.setPlaceholderText("Exact location")
        self.text_exact_loc.setText("office")

        # Map picker button — same fixed width as the old Lock button (46px)
        self.btn_map = QPushButton("⚲")
        self.btn_map.setFixedWidth(46)
        self.btn_map.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_map.setToolTip("Choose location on Map")
        self.btn_map.clicked.connect(self.on_map_clicked)

        self.obs_date = CompactDateEdit()
        self.obs_time = CompactTimeEdit()

        grid_layout.addWidget(_create_label("PROJECT"), 0, 0)
        grid_layout.addWidget(self.project_label, 0, 1)
        grid_layout.addWidget(_create_label("OFFICE"), 1, 0)
        grid_layout.addWidget(self.location_label, 1, 1)

        grid_layout.addWidget(_create_label("ADDRESS"), 2, 0)
        grid_layout.addWidget(self.office_address, 2, 1)
        grid_layout.addWidget(_create_label("LOCATION"), 3, 0)

        loc_layout = QHBoxLayout()
        loc_layout.setSpacing(6)
        loc_layout.addWidget(self.text_exact_loc)
        loc_layout.addWidget(self.btn_map)
        grid_layout.addLayout(loc_layout, 3, 1)

        grid_layout.addWidget(_create_label("DATE"), 4, 0)
        grid_layout.addWidget(self.obs_date, 4, 1)
        grid_layout.addWidget(_create_label("TIME"), 5, 0)
        grid_layout.addWidget(self.obs_time, 5, 1)

        tight_header_group.addLayout(grid_layout)
        main.addLayout(tight_header_group)

        self.toggles_container = QWidget()
        self.toggles_container.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

        toggles_layout = QVBoxLayout(self.toggles_container)
        toggles_layout.setContentsMargins(8, 8, 8, 8)
        toggles_layout.setSpacing(6)

        switches_layout = QVBoxLayout()
        switches_layout.setSpacing(4)
        self.contractor_switch = LabeledSwitch("Was the work performed by a Contractor?", start_on=False)
        self.hours_switch = LabeledSwitch("Was this observed during working hours?", start_on=False)
        switches_layout.addWidget(self.contractor_switch)
        switches_layout.addWidget(self.hours_switch)
        toggles_layout.addLayout(switches_layout)

        toggles_layout.addSpacing(8)

        segments_vbox = QVBoxLayout()
        segments_vbox.setSpacing(4)

        self.obs_type_segmented = AppleSegmentedControl(choices=["Behaviour", "Condition"], start_choice="Behaviour")
        segments_vbox.addWidget(self.obs_type_segmented)

        self.obs_safe_segmented = AppleSegmentedControl(choices=["Safe", "At Risk"], start_choice="Safe")
        segments_vbox.addWidget(self.obs_safe_segmented)

        self.office_segmented = AppleSegmentedControl(choices=["Hatch office", "Home office", "Site/Client"], start_choice="Hatch office")
        segments_vbox.addWidget(self.office_segmented)

        toggles_layout.addLayout(segments_vbox)

        main.addWidget(self.toggles_container)

        self.lbl_obs_details = _create_label("OBSERVATION DETAILS")
        main.addWidget(self.lbl_obs_details)
        self.observation_entry = QTextEdit()
        self.observation_entry.setFont(QFont("Source Sans Pro", 11))
        self.observation_entry.setMinimumHeight(60)
        self.observation_entry.setMaximumHeight(80)
        self.observation_entry.setPlaceholderText("Enter observation details...")
        self.observation_entry.textChanged.connect(lambda: self._set_textedit_highlight(self.observation_entry, False) if getattr(self.observation_entry, '_ai_highlighted', False) else None)
        main.addWidget(self.observation_entry)

        self.lbl_action = _create_label("IMMEDIATE ACTION")
        main.addWidget(self.lbl_action)
        self.action_entry = QTextEdit()
        self.action_entry.setFont(QFont("Source Sans Pro", 11))
        self.action_entry.setMinimumHeight(60)
        self.action_entry.setMaximumHeight(80)
        self.action_entry.setPlaceholderText("Enter immediate action taken...")
        self.action_entry.textChanged.connect(lambda: self._set_textedit_highlight(self.action_entry, False) if getattr(self.action_entry, '_ai_highlighted', False) else None)
        main.addWidget(self.action_entry)

        cat_vbox = QVBoxLayout()
        cat_vbox.setSpacing(2)

        self.lbl_category = _create_label("CATEGORY")
        cat_vbox.addWidget(self.lbl_category)

        cat_list = ["None"] + ROAMObservation().list_cats
        self.category_combo = SearchableComboBox(cat_list)
        self.category_combo.lineEdit().setPlaceholderText("Select category")

        def handle_cat_change(text):
            if text == "None":
                self.category_combo.setCurrentText("")

        self.category_combo.currentTextChanged.connect(handle_cat_change)

        cat_vbox.addWidget(self.category_combo)
        main.addLayout(cat_vbox)

        card_layout = QVBoxLayout()
        card_layout.setContentsMargins(0, 4, 0, 4)
        card_layout.setSpacing(4)
        card_layout.addWidget(_create_label("SAFETY CARD TYPE"))

        self.card_type_selector = CardTypeSelector()
        card_layout.addWidget(self.card_type_selector)
        main.addLayout(card_layout)

        main.addStretch()
        submit_layout = QHBoxLayout()
        self.submit_btn = QPushButton("Submit Observation")
        self.submit_btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.submit_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.submit_btn.clicked.connect(self.on_submit)

        submit_layout.addWidget(self.submit_btn)
        main.addLayout(submit_layout)

        scroll_area.setWidget(central)
        self.setCentralWidget(scroll_area)

    def setup_ai_integration(self, parent_layout):
        self.ai_container = QWidget()
        ai_layout = QVBoxLayout(self.ai_container)
        ai_layout.setContentsMargins(0, 0, 0, 0)
        ai_layout.setSpacing(0)

        self.ai_input = OverlayTextEdit(enable_audio=True)
        self.ai_input.setPlaceholderText("Describe your observation naturally or hit Start Recording...")
        self.ai_input.setFixedHeight(90)
        self.ai_input.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.ai_input.submit_requested.connect(self.on_ai_right_clicked)
        ai_layout.addWidget(self.ai_input)

        btn_container = QWidget()
        btn_layout = QHBoxLayout(btn_container)
        btn_layout.setContentsMargins(0, 0, 0, 0)
        btn_layout.setSpacing(0)

        self.btn_ai_left = QPushButton("Start Recording")
        self.btn_ai_right = QPushButton("Submit Prompt")

        self.btn_ai_left.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_ai_right.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_ai_left.setFixedHeight(36)
        self.btn_ai_right.setFixedHeight(36)

        self.btn_ai_left.clicked.connect(self.on_ai_left_clicked)
        self.btn_ai_right.clicked.connect(self.on_ai_right_clicked)

        btn_layout.addWidget(self.btn_ai_left)
        btn_layout.addWidget(self.btn_ai_right)

        ai_layout.addWidget(btn_container)
        parent_layout.addWidget(self.ai_container)
        parent_layout.addSpacing(4)

    # ------------------------------------------------------------------
    # Map picker button
    # ------------------------------------------------------------------
    def on_map_clicked(self):
        """Open the Map picker dialog."""
        if not WEB_ENGINE_AVAILABLE:
            QMessageBox.warning(
                self,
                "WebEngine Not Available",
                "The map picker requires PySide6-WebEngineWidgets.\n\n"
                "Install it with:\n  pip install PySide6-WebEngineWidgets\n\n"
                "You can type the location manually in the field above."
            )
            return

        dialog = MapPickerDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted and dialog.picked_address:
            address = dialog.picked_address
            # Populate the exact-location field
            self.text_exact_loc.setText(address)
            # Store for injection into the Copilot prompt
            self._map_location_hint = address

            # Try to auto-match a city from CITIES_LIST
            if not self.location_label.is_locked():
                addr_lower = address.lower()
                for city in CITIES_LIST:
                    if city.lower() in addr_lower or addr_lower.split(",")[0].strip() in city.lower():
                        self.location_label.setCurrentText(city)
                        if city in OFFICE_ADDRESS_MAP and not self.office_address.is_locked():
                            self.office_address.setCurrentText(OFFICE_ADDRESS_MAP[city])
                        break

    # ------------------------------------------------------------------

    def on_ai_left_clicked(self):
        if self.ai_state == "EDIT":
            if not self.is_recording:
                self.start_ai_recording()
            else:
                self.stop_ai_recording()
        elif self.ai_state == "RESULT":
            self.edit_previous_prompt()

    def on_ai_right_clicked(self):
        if self.ai_state == "EDIT":
            self.ai_prompt_text = self.ai_input.toPlainText().strip()
            if not self.ai_prompt_text:
                QMessageBox.warning(self, "Empty Prompt", "Please enter or record an observation first.")
                return
            self.send_to_copilot(self.ai_prompt_text)

        elif self.ai_state == "PROCESSING":
            self.cancel_ai_processing()

        elif self.ai_state == "RESULT":
            self.reset_ai_to_edit()

    def edit_previous_prompt(self):
        self.extracted_data = None
        self.location_retried = False
        self.ai_state = "EDIT"
        self.ai_input.setReadOnly(False)
        self.ai_input.clear()
        self.ai_input.setTextColor(QColor(THEME.get_colors()['input_text']))
        self.ai_input.setFont(QFont("Source Sans Pro", 14))
        self.ai_input.setPlainText(self.ai_prompt_text)

        self.btn_ai_left.setEnabled(True)
        self.btn_ai_left.setText("Start Recording")
        self.btn_ai_right.setText("Submit Prompt")
        self.clear_highlights()
        self.apply_ai_theme(THEME.get_colors())
        self.set_form_enabled(True)

        self.start_preloaded_copilot()

    def reset_ai_to_edit(self):
        if hasattr(self, '_ai_fill_timer'):
            self._ai_fill_timer.stop()

        self.ai_prompt_text = ""
        self.extracted_data = None
        self.location_retried = False
        self._map_location_hint = ""
        self.ai_state = "EDIT"
        self.ai_input.clear()
        self.ai_input.setTextColor(QColor(THEME.get_colors()['input_text']))
        self.ai_input.setFont(QFont("Source Sans Pro", 14))
        self.ai_input.setReadOnly(False)

        self.btn_ai_left.setEnabled(True)
        self.btn_ai_left.setText("Start Recording")
        self.btn_ai_right.setText("Submit Prompt")
        self.clear_highlights()
        self.apply_ai_theme(THEME.get_colors())
        self.set_form_enabled(True)

    def start_ai_recording(self):
        self.is_recording = True
        self.btn_ai_left.setText("Stop Recording")
        self.ai_input.wave_widget.start()
        self.voice_worker = VoiceWorker()
        self.voice_worker.ready_signal.connect(self.on_ai_voice_ready)
        self.voice_worker.processing_signal.connect(self.on_ai_voice_processing)
        self.voice_worker.finished_signal.connect(self.on_ai_voice_finished)
        self.voice_worker.start()

    def on_ai_voice_ready(self):
        self.ai_input.setPlaceholderText("Listening... Speak now.")

    def stop_ai_recording(self):
        self.is_recording = False
        self.ai_input.wave_widget.stop()
        if self.voice_worker and self.voice_worker.isRunning():
            self.btn_ai_left.setText("Converting...")
            self.voice_worker.stop()
        else:
            self.btn_ai_left.setText("Start Recording")
            self.ai_input.setPlaceholderText("Describe your observation naturally or hit Start Recording...")

    def on_ai_voice_processing(self):
        self.btn_ai_left.setText("Converting...")

    def on_ai_voice_finished(self, text, success, audio_path):
        self.is_recording = False
        self.btn_ai_left.setText("Start Recording")
        self.ai_input.wave_widget.stop()
        self.ai_input.set_audio_path(audio_path)
        self.ai_input.setPlaceholderText("Describe your observation naturally or hit Start Recording...")

        if success and text:
            current = self.ai_input.toPlainText()
            self.ai_input.setText(f"{current} {text}".strip())
        elif not success:
            QMessageBox.warning(self, "Voice Error", text)

    def send_to_copilot(self, full_text):
        if self.is_recording:
            self.stop_ai_recording()

        if not hasattr(self, 'copilot_worker') or not self.copilot_worker.isRunning():
            self.start_preloaded_copilot()

        self.ai_state = "PROCESSING"
        self.ai_input.setReadOnly(True)
        self.btn_ai_left.setEnabled(False)
        self.btn_ai_right.setText("CANCEL")
        self.apply_ai_theme(THEME.get_colors())
        self.set_form_enabled(False)
        self.start_ai_status_updates()

        self.ai_timeout_timer.start(45000)
        self.ai_input.progress_widget.show()

        today_str = datetime.now().strftime("%d %B %Y")
        categories = ", ".join(ROAMObservation().list_cats)

        # Inject map location hint if the user picked one
        map_hint_clause = ""
        if self._map_location_hint:
            map_hint_clause = (
                f"\n\nMAP LOCATION CONTEXT: The user selected the following location on the Map: "
                f'"{self._map_location_hint}". '
                f"Use this as the primary source for the 'location', 'office_city', and any address fields. "
                f"Convert the map address into a natural human-readable description for the 'location' field "
                f"(e.g. use the street name, building, or neighbourhood rather than raw coordinates)."
            )

        mega_prompt = (
            f"Analyze the following safety observation report and extract the details into a strict JSON format. "
            f"If a field is not mentioned, use the defaults provided or leave as an empty string.\n\n"
            f"IMPORTANT NOTE ON DATES: Today's date is {today_str}. If the report mentions 'today', 'yesterday', or gives no date at all, resolve the date relative to {today_str}.\n\n"
            f"Report: '{full_text}'{map_hint_clause}\n\n"
            f"Return ONLY valid JSON matching this exact structure (no markdown tags):\n"
            f"{{\n"
            f'  "error": "string (If the input is gibberish, random background noise, or completely unrelated to a safety observation, explain why here and leave other fields empty. Otherwise leave empty.)",\n'
            f'  "project": "string (Extract the project name or number if mentioned, otherwise leave empty)",\n'
            f'  "office_city": "string (Extract the city or office name if mentioned, otherwise leave empty)",\n'
            f'  "location": "string (Extract the exact location where the incident happened, like \'hallway\', \'near a desk\', or specific room. Default to \'Office\' or \'Home\' ONLY if there is a slight mention of being at the office or working from home. Otherwise, identify the exact place.)",\n'
            f'  "date": "dd MMMM yyyy" (Default: "{today_str}"),\n'
            f'  "time": "HH:mm" (Determine the time of the event. If outside working hours, pick a time before 09:00 or after 17:00 unless weekend. If morning, pick a random half-hour slot between 09:00 and 12:00. If lunch, pick a random half-hour slot between 12:00 and 14:00. If afternoon, pick a random half-hour slot between 14:00 and 17:00. Default to "{datetime.now().strftime("%H:%M")}" if completely unknown.),\n'
            f'  "contractor": "Yes" or "No" (Default "No"),\n'
            f'  "working_hours": "Yes" or "No" (Default "Yes"),\n'
            f'  "obs_type": "Behaviour" or "Condition",\n'
            f'  "safe": "Safe" or "At Risk",\n'
            f'  "office": "Hatch office", "Home office", or "Site/Client" (Strict rules: Use "Site/Client" ONLY if explicitly mentioning visiting a client office, being on site, or being at an industrial/mine site. Use "Home office" ONLY if explicitly mentioning working from home or being at home. Default to "Hatch office" for all other cases, including traveling to or from the office.),\n'
            f'  "details": "string",\n'
            f'  "action": "string",\n'
            f'  "category": "string (MUST exactly match one of: {categories})",\n'
            f'  "card_type": "Design", "Field", or "Office"\n'
            f"}}"
        )

        self.copilot_worker.command_queue.put({'action': 'prompt', 'text': mega_prompt})

    def on_ai_timeout(self):
        self.cancel_ai_processing()
        msg = QMessageBox(self)
        msg.setWindowTitle("AI Processing Failed")
        msg.setText("AI processing failed. Restart app")
        msg.setStandardButtons(QMessageBox.StandardButton.Close | QMessageBox.StandardButton.Retry)
        msg.button(QMessageBox.StandardButton.Retry).setText("Restart")

        ret = msg.exec()
        if ret == QMessageBox.StandardButton.Retry:
            os.execl(sys.executable, sys.executable, *sys.argv)

    def cancel_ai_processing(self):
        self.ai_timeout_timer.stop()
        self.ai_input.progress_widget.hide()
        self.cancel_copilot = True
        self.status_timer.stop()
        if hasattr(self, '_ai_fill_timer'):
            self._ai_fill_timer.stop()
        self.stop_copilot_browser()
        self.edit_previous_prompt()

    def start_ai_status_updates(self):
        self.current_status_index = 0
        self.status_timer.start(3500)
        self.ai_input.setHtml("<div style='text-align: center; color: #888; font-style: italic;'><br>Waking up the AI assistant...</div>")

    def update_random_status(self):
        if self.current_status_index < len(self.status_messages):
            msg = self.status_messages[self.current_status_index]
            self.ai_input.setHtml(f"<div style='text-align: center; color: #888; font-style: italic;'><br>{msg}</div>")
            self.current_status_index += 1
            self.status_timer.start(3500)

    def on_copilot_finished(self, response_text):
        if self.cancel_copilot:
            return

        self.ai_timeout_timer.stop()
        self.ai_input.progress_widget.hide()
        self.status_timer.stop()

        cleaned_text = response_text
        match = re.search(r'\{.*\}', response_text, re.DOTALL)
        if match:
            cleaned_text = match.group(0)

        try:
            parsed_data = json.loads(cleaned_text)

            err_msg = parsed_data.get("error", "")
            if err_msg and err_msg.lower() not in ["none", "null", "n/a", ""]:
                self.cancel_ai_processing()
                QMessageBox.warning(self, "AI Validation Failed", f"Copilot could not determine a valid safety observation from the input:\n\n{err_msg}")
                return

            loc = parsed_data.get("location", "").strip()

            if not loc or loc.lower() in ["none", "null", "n/a", ""]:
                if not self.location_retried:
                    self.location_retried = True
                    self.handle_missing_location()
                    return
                else:
                    parsed_data["location"] = "Undetermined"
            else:
                parsed_data["location"] = loc[0].upper() + loc[1:]

            self.extracted_data = parsed_data

            self.stop_copilot_browser()
            self.apply_ai_to_form()

        except json.JSONDecodeError:
            self.cancel_ai_processing()
            QMessageBox.warning(self, "AI Error", "Copilot did not return valid data.")

    def stop_copilot_browser(self):
        if hasattr(self, 'copilot_worker') and self.copilot_worker.isRunning():
            self.copilot_worker.command_queue.put({'action': 'close'})
            self.copilot_worker.wait(2000)

    def handle_missing_location(self):
        dialog = LocationPromptDialog(self)
        if dialog.exec():
            extra_info = dialog.extra_info
            if extra_info:
                self.ai_prompt_text += f"\n\nAdditional Location Details: {extra_info}"
                self.send_to_copilot(self.ai_prompt_text)
                return True

        self.cancel_ai_processing()
        return False

    def display_ai_results(self):
        self.ai_state = "RESULT"
        self.btn_ai_left.setEnabled(True)
        self.btn_ai_left.setText("Edit previous prompt")
        self.btn_ai_right.setText("Write new prompt")
        self.apply_ai_theme(THEME.get_colors())
        self.set_form_enabled(True)

        c = THEME.get_colors()

        html = f"""
        <div style="color: {c['text']}; padding: 15px; text-align: center; margin-top: 20px; font-family: 'Source Sans Pro'; font-size: 15px;">
            <b>Roam Observation Form Updated<br>Click Submit Observation</b>
        </div>
        """
        self.ai_input.setHtml(html)

        if not self.worker or not self.worker.isRunning():
            self.worker = WorkerThread(headless=not self.debug_roam)
            self.worker.finished_success.connect(self.on_population_finished)
            self.worker.start()
            self.worker.command_queue.put({'action': 'preload'})

    def apply_ai_to_form(self):
        data = self.extracted_data
        if not data:
            self.display_ai_results()
            return

        c = THEME.get_colors()
        sc = c['success']

        self._ai_fill_tasks = []

        extracted_project = data.get("project", "").strip()
        if extracted_project:
            best_match = "Hatch Global (Project View)"
            for p in PROJECTS_LIST:
                if extracted_project.lower() in p.lower():
                    best_match = p
                    break
            if not self.project_label.is_locked():
                def task_project():
                    self.project_label.setCurrentText(best_match)
                    self.project_label.set_ai_highlight(True)
                self._ai_fill_tasks.append(task_project)
        else:
            if not self.project_label.is_locked():
                def task_project_default():
                    self.project_label.setCurrentText("Hatch Global (Project View)")
                    self.project_label.set_ai_highlight(True)
                self._ai_fill_tasks.append(task_project_default)

        extracted_office = data.get("office_city", "").strip()
        if extracted_office:
            best_office = ""
            for city in CITIES_LIST:
                if extracted_office.lower() in city.lower():
                    best_office = city
                    break
            if best_office:
                if not self.location_label.is_locked():
                    def task_office_city():
                        self.location_label.setCurrentText(best_office)
                        self.location_label.set_ai_highlight(True)
                    self._ai_fill_tasks.append(task_office_city)
                if best_office in OFFICE_ADDRESS_MAP and not self.office_address.is_locked():
                    def task_office_address():
                        self.office_address.setCurrentText(OFFICE_ADDRESS_MAP[best_office])
                        self.office_address.set_ai_highlight(True)
                    self._ai_fill_tasks.append(task_office_address)

        if data.get("location"):
            def task_loc():
                self.text_exact_loc.setText(data.get("location"))
                self.text_exact_loc.set_ai_highlight(True)
            self._ai_fill_tasks.append(task_loc)

        if data.get("date"):
            date_obj = QDate.fromString(data.get("date"), "dd MMMM yyyy")
            if date_obj.isValid():
                def task_date():
                    self.obs_date.setDate(date_obj)
                    self.obs_date.set_ai_highlight(True)
                self._ai_fill_tasks.append(task_date)

        if data.get("time"):
            time_obj = QTime.fromString(data.get("time"), "HH:mm")
            if time_obj.isValid():
                def task_time():
                    self.obs_time.setTime(time_obj)
                    self.obs_time.set_ai_highlight(True)
                self._ai_fill_tasks.append(task_time)

        if data.get("contractor"):
            def task_contractor():
                self.contractor_switch.set_selected(data.get("contractor"))
                self.contractor_switch.set_highlight(True, sc)
            self._ai_fill_tasks.append(task_contractor)

        if data.get("working_hours"):
            def task_hours():
                self.hours_switch.set_selected(data.get("working_hours"))
                self.hours_switch.set_highlight(True, sc)
            self._ai_fill_tasks.append(task_hours)

        if data.get("obs_type"):
            def task_obs_type():
                self.obs_type_segmented.set_selected(data.get("obs_type"))
                self.obs_type_segmented.set_ai_highlight(True)
            self._ai_fill_tasks.append(task_obs_type)

        if data.get("safe"):
            def task_safe():
                self.obs_safe_segmented.set_selected(data.get("safe"))
                self.obs_safe_segmented.set_ai_highlight(True)
            self._ai_fill_tasks.append(task_safe)

        if data.get("office"):
            def task_office():
                self.office_segmented.set_selected(data.get("office"))
                self.office_segmented.set_ai_highlight(True)
            self._ai_fill_tasks.append(task_office)

        if data.get("details"):
            def task_details():
                self.observation_entry.setPlainText(data.get("details"))
                self._set_textedit_highlight(self.observation_entry, True)
            self._ai_fill_tasks.append(task_details)

        if data.get("action"):
            def task_action():
                self.action_entry.setPlainText(data.get("action"))
                self._set_textedit_highlight(self.action_entry, True)
            self._ai_fill_tasks.append(task_action)

        if data.get("category"):
            def task_cat():
                self.category_combo.setCurrentText(data.get("category"))
                self.category_combo.set_ai_highlight(True)
            self._ai_fill_tasks.append(task_cat)

        if data.get("card_type"):
            def task_card():
                self.card_type_selector.set_selected(data.get("card_type"))
                self.card_type_selector.set_ai_highlight(True)
            self._ai_fill_tasks.append(task_card)

        self._ai_fill_timer = QTimer(self)
        self._ai_fill_timer.timeout.connect(self._execute_next_ai_fill_task)
        self._ai_fill_timer.start(150)

    def _execute_next_ai_fill_task(self):
        if hasattr(self, '_ai_fill_tasks') and self._ai_fill_tasks:
            task = self._ai_fill_tasks.pop(0)
            task()
        else:
            if hasattr(self, '_ai_fill_timer'):
                self._ai_fill_timer.stop()
            self.display_ai_results()

    def open_bulk_add(self):
        self.bulk_window = BulkAddWindow(self)
        self.bulk_window.show()

    def reset_form(self):
        if not self.project_label.is_locked():
            self.project_label.setCurrentText("")
        if not self.location_label.is_locked():
            self.location_label.setCurrentText("")
        if not self.office_address.is_locked():
            self.office_address.setCurrentText("")

        self.text_exact_loc.setText("")
        self.observation_entry.clear()
        self.action_entry.clear()
        self.category_combo.setCurrentText("")

        self.obs_date.setDate(QDate.currentDate())
        self.obs_time.setTime(QTime.currentTime())

        self.contractor_switch.set_selected("No")
        self.hours_switch.set_selected("No")
        self.obs_type_segmented.set_selected("Behaviour")
        self.obs_safe_segmented.set_selected("Safe")
        self.office_segmented.set_selected("Hatch office")

        self.card_type_selector.set_selected("Field")

        self.lbl_obs_details.setText("OBSERVATION DETAILS")
        self.lbl_action.setText("IMMEDIATE ACTION")
        self.lbl_category.setText("CATEGORY")
        self.clear_highlights()
        self._map_location_hint = ""

    def set_defaults(self):
        obs = self.collect_form_data()
        save_dir = os.path.expanduser("~/.roam_helper")
        os.makedirs(save_dir, exist_ok=True)
        obs.to_json(os.path.join(save_dir, "custom_defaults.json"))
        QMessageBox.information(self, "Defaults Saved", "Current form values have been saved as the new default.")

    def restore_defaults(self):
        custom_path = os.path.expanduser("~/.roam_helper/custom_defaults.json")
        if os.path.exists(custom_path):
            try:
                obs = ROAMObservation.from_json(custom_path)
                self.populate_form(obs)
                self.lbl_obs_details.setText("OBSERVATION DETAILS")
                self.lbl_action.setText("IMMEDIATE ACTION")
                self.lbl_category.setText("CATEGORY")
                self.clear_highlights()
                return
            except Exception:
                pass

        if not self.project_label.is_locked():
            self.project_label.setCurrentText("Hatch Global (Project View)")
        if not self.location_label.is_locked():
            self.location_label.setCurrentText("Johannesburg")
        if not self.office_address.is_locked():
            self.office_address.setCurrentText("58 Emerald Parkway Road, Greenstone Hill")

        self.text_exact_loc.setText("office")
        self.observation_entry.clear()
        self.action_entry.clear()
        self.category_combo.setCurrentIndex(0)

        self.obs_date.setDate(QDate.currentDate())
        self.obs_time.setTime(QTime.currentTime())

        self.contractor_switch.set_selected("No")
        self.hours_switch.set_selected("No")
        self.obs_type_segmented.set_selected("Behaviour")
        self.obs_safe_segmented.set_selected("Safe")
        self.office_segmented.set_selected("Hatch office")

        self.card_type_selector.set_selected("Field")

        self.lbl_obs_details.setText("OBSERVATION DETAILS")
        self.lbl_action.setText("IMMEDIATE ACTION")
        self.lbl_category.setText("CATEGORY")
        self.clear_highlights()

    def collect_form_data(self):
        backend_date = self.obs_date.date().toString("dd/MMM/yyyy")

        raw_address = self.office_address.currentText().strip()
        plain_address = raw_address.replace('\n', ', ').replace('\r', '')

        full_card_type = get_full_card_type(self.card_type_selector.get_selected())

        return ROAMObservation(
            observation_text=self.observation_entry.toPlainText().strip(),
            action_text=self.action_entry.toPlainText().strip(),
            category_text=self.category_combo.currentText().strip(),
            card_type=full_card_type,
            office_location=self.office_segmented.get_selected(),
            contractor_work=self.contractor_switch.get_selected(),
            work_hours=self.hours_switch.get_selected(),
            obs_type=self.obs_type_segmented.get_selected(),
            obs_safe=self.obs_safe_segmented.get_selected(),
            text_project=self.project_label.currentText().strip(),
            text_location=self.location_label.currentText().strip(),
            text_office=plain_address,
            text_exact_loc=self.text_exact_loc.text().strip(),
            obs_date=backend_date,
            obs_time=self.obs_time.time().toString("HH:mm"),
        )

    def save_observation(self, obs):
        save_dir = os.path.expanduser("~/.roam_helper")
        os.makedirs(save_dir, exist_ok=True)
        filename = f"roam_observation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        obs.to_json(os.path.join(save_dir, filename))

    def save_last_observation(self, obs):
        save_dir = os.path.expanduser("~/.roam_helper")
        os.makedirs(save_dir, exist_ok=True)
        obs.to_json(os.path.join(save_dir, "last_observation.json"))

    def load_last_observation(self):
        try:
            last_file = os.path.expanduser("~/.roam_helper/last_observation.json")
            if os.path.exists(last_file):
                self.populate_form(ROAMObservation.from_json(last_file))
        except Exception:
            pass

    def populate_form(self, obs):
        self.observation_entry.setPlainText(obs.observation_text)
        self.action_entry.setPlainText(obs.action_text)

        if not self.project_label.is_locked():
            self.project_label.setCurrentText(obs.text_project)
        if not self.location_label.is_locked():
            self.location_label.setCurrentText(obs.text_location)
        if not self.office_address.is_locked():
            self.office_address.setCurrentText(obs.text_office)

        self.text_exact_loc.setText(obs.text_exact_loc)

        date_obj = QDate.fromString(obs.obs_date, "dd/MMM/yyyy")
        if not date_obj.isValid():
            date_obj = QDate.fromString(obs.obs_date, "dd MMMM yyyy")
        if not date_obj.isValid():
            date_obj = QDate.fromString(obs.obs_date, "dd/MMM/yy")

        if date_obj.isValid():
            self.obs_date.setDate(date_obj)

        time_obj = QTime.fromString(obs.obs_time, "HH:mm")
        if time_obj.isValid():
            self.obs_time.setTime(time_obj)

        self.category_combo.setCurrentText(obs.category_text)

        self.office_segmented.set_selected(obs.office_location)
        self.contractor_switch.set_selected(obs.contractor_work)
        self.hours_switch.set_selected(obs.work_hours)
        self.obs_type_segmented.set_selected(obs.obs_type)

        if hasattr(self, 'obs_safe_segmented'):
            sv = "At Risk" if "risk" in obs.obs_safe.lower() or "not" in obs.obs_safe.lower() else "Safe"
            self.obs_safe_segmented.set_selected(sv)

        self.card_type_selector.set_selected(obs.card_type)

    def on_submit(self):
        try:
            valid = True
            c = THEME.get_colors()

            self.all_headings[0].setText("PROJECT")
            self.all_headings[1].setText("OFFICE")
            self.all_headings[2].setText("ADDRESS")
            self.lbl_obs_details.setText("OBSERVATION DETAILS")
            self.lbl_action.setText("IMMEDIATE ACTION")
            self.lbl_category.setText("CATEGORY")

            self.clear_highlights()

            proj_text = self.project_label.currentText().strip()
            loc_text = self.location_label.currentText().strip()
            addr_text = self.office_address.currentText().strip()
            obs_text = self.observation_entry.toPlainText().strip()
            action_text = self.action_entry.toPlainText().strip()
            cat_text = self.category_combo.currentText().strip()

            if not proj_text:
                self.all_headings[0].setText(f"PROJECT <span style='color:{c['danger_text']}'>* Required</span>")
                self.project_label.setStyleSheet(self.project_label.styleSheet() + f"\nQComboBox {{ border: 2px solid {c['danger_text']}; }}")
                valid = False

            if not loc_text:
                self.all_headings[1].setText(f"OFFICE <span style='color:{c['danger_text']}'>* Required</span>")
                self.location_label.setStyleSheet(self.location_label.styleSheet() + f"\nQComboBox {{ border: 2px solid {c['danger_text']}; }}")
                valid = False

            if not addr_text:
                self.all_headings[2].setText(f"ADDRESS <span style='color:{c['danger_text']}'>* Required</span>")
                self.office_address.setStyleSheet(self.office_address.styleSheet() + f"\nQComboBox {{ border: 2px solid {c['danger_text']}; }}")
                valid = False

            if not obs_text:
                self.lbl_obs_details.setText(f"OBSERVATION DETAILS <span style='color:{c['danger_text']}'>* Required</span>")
                self.observation_entry.setStyleSheet(self.observation_entry.styleSheet() + f"\nQTextEdit {{ border: 2px solid {c['danger_text']}; }}")
                valid = False

            if not action_text:
                self.lbl_action.setText(f"IMMEDIATE ACTION <span style='color:{c['danger_text']}'>* Required</span>")
                self.action_entry.setStyleSheet(self.action_entry.styleSheet() + f"\nQTextEdit {{ border: 2px solid {c['danger_text']}; }}")
                valid = False

            if not cat_text or cat_text == "None":
                self.lbl_category.setText(f"CATEGORY <span style='color:{c['danger_text']}'>* Required</span>")
                self.category_combo.setStyleSheet(self.category_combo.styleSheet() + f"\nQComboBox {{ border: 2px solid {c['danger_text']}; }}")
                valid = False

            if not valid:
                return

            obs = self.collect_form_data()
            self.save_last_observation(obs)
            self.save_observation(obs)

            self.progress_dialog = ProgressDialog(self)
            self.progress_dialog.cancel_btn.clicked.connect(self.cancel_submission)
            self.progress_dialog.show()

            if not self.worker or not self.worker.isRunning():
                self.worker = WorkerThread(headless=not self.debug_roam)
                self.worker.finished_success.connect(self.on_population_finished)
                self.worker.start()
                self.worker.command_queue.put({'action': 'preload'})

            self.worker.command_queue.put({'action': 'submit', 'observation': obs})

        except Exception as e:
            QMessageBox.critical(self, "Error", f"Failed to submit: {str(e)}")

    def cancel_submission(self):
        if self.worker and self.worker.isRunning():
            self.worker.cancel()
        self.progress_dialog.reject()

    def on_population_finished(self, success, error_msg):
        if hasattr(self, 'progress_dialog') and self.progress_dialog.isVisible():
            if success:
                self.progress_dialog.show_success("Observation successfully submitted!")
                self.reset_ai_to_edit()
            else:
                self.progress_dialog.title.setText("Submission Failed.")
                self.progress_dialog.progress_bar.hide()
                self.progress_dialog.show_error(error_msg)

        self.start_preloaded_copilot()

    def closeEvent(self, event):
        if self.is_recording:
            self.stop_ai_recording()

        if self.status_timer.isActive():
            self.status_timer.stop()

        if hasattr(self, 'copilot_worker') and self.copilot_worker.isRunning():
            self.copilot_worker.command_queue.put({'action': 'close'})
            if not self.copilot_worker.wait(2000):
                self.copilot_worker.terminate()

        if self.worker and self.worker.isRunning():
            self.worker.cancel()
            self.worker.command_queue.put({'action': 'close'})
            self.worker.wait(1000)

        super().closeEvent(event)


class BulkAddWindow(QMainWindow):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Bulk Add Observations")
        self.resize(1000, 700)
        self.setup_ui()
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def setup_ui(self):
        central = QWidget()
        central.setObjectName("central_widget")
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        title_layout = QHBoxLayout()
        title = QLabel("Bulk Add Observations")
        title.setFont(QFont("Source Sans Pro", 14, QFont.Weight.Bold))
        title_layout.addWidget(title)
        title_layout.addStretch()

        self.btn_use_default = QPushButton("Use Default")
        self.btn_use_default.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_use_default.clicked.connect(self.populate_default_vfl1)
        title_layout.addWidget(self.btn_use_default)

        self.btn_clear = QPushButton("Clear All")
        self.btn_clear.clicked.connect(self.clear_table)
        title_layout.addWidget(self.btn_clear)
        layout.addLayout(title_layout)

        labels = [
            "PROJECT", "OFFICE", "ADDRESS", "LOCATION", "DATE", "TIME",
            "CONTRACTOR?", "WORK HOURS?", "BEHAVIOUR/CONDITION",
            "SAFE/NOT SAFE", "OFFICE LOCATION", "DETAILS", "ACTION",
            "CATEGORY", "SAFETY CARD TYPE"
        ]
        self.table = ExcelPasteTable(len(labels), 50)
        self.table.setVerticalHeaderLabels(labels)
        self.table.setHorizontalHeaderLabels([f"VFL {i+1}" for i in range(50)])

        self.table.itemChanged.connect(self.validate_table)

        layout.addWidget(self.table)

        bottom_layout = QHBoxLayout()
        bottom_layout.addStretch()
        self.submit_btn = QPushButton("Submit Observations")
        self.submit_btn.clicked.connect(self.on_submit_bulk)
        bottom_layout.addWidget(self.submit_btn)
        layout.addLayout(bottom_layout)

    def apply_theme(self, c):
        self.setStyleSheet(f"""
            QMainWindow, QWidget#central_widget {{ background-color: {c['bg']}; }}
            QLabel {{ color: {c['text']}; }}
        """)

        self.btn_clear.setStyleSheet(f"""
            QPushButton {{ padding: 6px 12px; border: 1px solid {c['danger_border']}; border-radius: 4px; background-color: {c['danger_bg']}; color: {c['danger_text']}; }}
            QPushButton:hover {{ background-color: {c['danger_border']}; color: #FFFFFF; }}
        """)
        self.btn_use_default.setStyleSheet(f"""
            QPushButton {{ padding: 6px 12px; border: 1px solid {c['border']}; border-radius: 4px; background-color: {c['input_bg']}; color: {c['text']}; font-weight: 600; font-size: 11px; }}
            QPushButton:hover {{ background-color: {c['surface_hover']}; }}
        """)

        self.validate_table()

    def validate_table(self):
        self.table.blockSignals(True)
        all_valid = True

        c = THEME.get_colors()
        default_color = QColor(c['input_text'])
        error_color = QColor(c['danger_text'])

        for col in range(self.table.columnCount()):
            project_item = self.table.item(0, col)
            details_item = self.table.item(11, col)

            project_text = project_item.text().strip() if project_item else ""
            details_text = details_item.text().strip() if details_item else ""

            if not project_text and not details_text:
                for row in range(self.table.rowCount()):
                    it = self.table.item(row, col)
                    if it:
                        it.setForeground(default_color)
                continue

            for row in range(self.table.rowCount()):
                item = self.table.item(row, col)
                if not item:
                    item = QTableWidgetItem("")
                    self.table.setItem(row, col, item)

                val = item.text().strip()
                is_valid = True

                if row == 4:
                    d1 = QDate.fromString(val, "dd/MMM/yyyy")
                    d2 = QDate.fromString(val, "dd MMMM yyyy")
                    d3 = QDate.fromString(val, "dd/MMM/yy")
                    if not (d1.isValid() or d2.isValid() or d3.isValid()):
                        is_valid = False
                elif row == 5:
                    if not QTime.fromString(val, "HH:mm").isValid():
                        is_valid = False
                elif row in [6, 7]:
                    if val.lower() not in ["yes", "no"]:
                        is_valid = False
                elif row == 8:
                    if val.lower() not in ["behaviour", "condition"]:
                        is_valid = False
                elif row == 9:
                    if val.lower() not in ["safe", "at risk", "not safe"]:
                        is_valid = False
                elif row == 10:
                    if val.lower() not in ["hatch office", "home office", "site/client", "site/client office", "site"]:
                        is_valid = False
                elif row in [11, 12, 13]:
                    if not val:
                        is_valid = False
                elif row == 14:
                    if val.lower() not in ["design", "field", "office"]:
                        is_valid = False

                if is_valid:
                    item.setForeground(default_color)
                else:
                    item.setForeground(error_color)
                    all_valid = False

        self.submit_btn.setEnabled(all_valid)
        if all_valid:
            self.submit_btn.setStyleSheet(f"""
                QPushButton {{ padding: 12px 20px; border: none; border-radius: 8px; background-color: {c['primary']}; font-weight: bold; color: #FFFFFF; font-size: 14px; }}
                QPushButton:hover {{ background-color: {c['primary_hover']}; }}
            """)
        else:
            self.submit_btn.setStyleSheet(f"""
                QPushButton {{ padding: 12px 20px; border: none; border-radius: 8px; background-color: {c['border']}; font-weight: bold; color: {c['text_muted']}; font-size: 14px; }}
            """)

        self.table.blockSignals(False)

    def clear_table(self):
        for row in range(self.table.rowCount()):
            for col in range(self.table.columnCount()):
                item = self.table.item(row, col)
                if item:
                    item.setText("")
        self.validate_table()

    def _get_hardcoded_defaults(self):
        return ["Hatch Global (Project View)", "Johannesburg", "58 Emerald Parkway Road, Greenstone Hill", "office", QDate.currentDate().toString("dd/MMM/yyyy"), QTime.currentTime().toString("HH:mm"), "No", "No", "Behaviour", "Safe", "Hatch office", "", "", "", "Field"]

    def populate_default_vfl1(self):
        custom_path = os.path.expanduser("~/.roam_helper/custom_defaults.json")
        if os.path.exists(custom_path):
            try:
                obs = ROAMObservation.from_json(custom_path)
                defaults = [
                    obs.text_project,
                    obs.text_location,
                    obs.text_office,
                    obs.text_exact_loc,
                    QDate.currentDate().toString("dd/MMM/yyyy"),
                    QTime.currentTime().toString("HH:mm"),
                    obs.contractor_work,
                    obs.work_hours,
                    obs.obs_type,
                    "At Risk" if "risk" in obs.obs_safe.lower() or "not" in obs.obs_safe.lower() else "Safe",
                    obs.office_location,
                    obs.observation_text,
                    obs.action_text,
                    obs.category_text,
                    obs.card_type
                ]
            except Exception:
                defaults = self._get_hardcoded_defaults()
        else:
            defaults = self._get_hardcoded_defaults()

        for row, val in enumerate(defaults):
            item = self.table.item(row, 0)
            if not item:
                item = QTableWidgetItem()
                self.table.setItem(row, 0, item)
            item.setText(val)

        self.validate_table()

    def _get_cell(self, row, col):
        item = self.table.item(row, col)
        return item.text().strip() if item else ""

    def collect_all_observations(self):
        observations = []
        for col in range(self.table.columnCount()):
            project = self._get_cell(0, col)
            details = self._get_cell(11, col)

            if not project and not details:
                continue

            raw_address = self._get_cell(2, col)
            plain_address = raw_address.replace('\n', ', ').replace('\r', '').strip()

            safe_raw = self._get_cell(9, col).strip().lower()
            safe_val = "At Risk" if ("risk" in safe_raw or "not" in safe_raw) else "Safe"

            full_card_type = get_full_card_type(self._get_cell(14, col) or "Field")

            obs = ROAMObservation(
                text_project=self._get_cell(0, col) or "H-369146",
                text_location=self._get_cell(1, col) or "Saskatoon",
                text_office=plain_address or "121 Research Drive, Saskatoon",
                text_exact_loc=self._get_cell(3, col) or "office",
                obs_date=self._get_cell(4, col) or QDate.currentDate().toString("dd/MMM/yyyy"),
                obs_time=self._get_cell(5, col) or QTime.currentTime().toString("HH:mm"),
                contractor_work=self._get_cell(6, col) or "No",
                work_hours=self._get_cell(7, col) or "No",
                obs_type=self._get_cell(8, col) or "Behaviour",
                obs_safe=safe_val,
                office_location=self._get_cell(10, col) or "Hatch office",
                observation_text=details,
                action_text=self._get_cell(12, col),
                category_text=self._get_cell(13, col),
                card_type=full_card_type
            )
            observations.append(obs)
        return observations

    def on_submit_bulk(self):
        observations = self.collect_all_observations()

        if not observations:
            QMessageBox.warning(self, "Empty Table", "No data found to submit. Please paste data first.")
            return

        self.progress_dialog = ProgressDialog(self, "Submitting Bulk Observations...")
        self.progress_dialog.update_counts(1, len(observations), 0, 0)
        self.progress_dialog.cancel_btn.clicked.connect(self.cancel_bulk)
        self.progress_dialog.show()

        self.worker = BulkWorkerThread(observations)
        self.worker.update_counts.connect(self.progress_dialog.update_counts)
        self.worker.finished_bulk.connect(self.on_bulk_finished)
        self.worker.start()

    def cancel_bulk(self):
        if hasattr(self, 'worker') and self.worker.isRunning():
            self.worker.cancel()
        self.progress_dialog.reject()

    def on_bulk_finished(self, success_count, fail_count, was_cancelled):
        if hasattr(self, 'progress_dialog') and self.progress_dialog.isVisible():
            if was_cancelled:
                self.progress_dialog.show_error(f"Cancelled.\nSubmitted: {success_count} | Failed: {fail_count}")
            elif fail_count == 0:
                self.progress_dialog.show_success(f"All {success_count} Submitted!")
            else:
                self.progress_dialog.show_error(f"Finished with errors.\nSuccess: {success_count} | Failed: {fail_count}")


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setQuitOnLastWindowClosed(True)

    icon_path = get_resource_path("roamicon.ico")
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))

    THEME.setup_system_theme_sync()

    socket = QTcpSocket()
    socket.connectToHost(QHostAddress.LocalHost, PORT)

    if socket.waitForConnected(500):
        socket.write(b"WAKE_UP")
        socket.waitForBytesWritten(500)
        socket.close()
        sys.exit(0)

    server = QTcpServer()
    server.listen(QHostAddress.LocalHost, PORT)

    splash_pixmap = QPixmap(400, 250)
    splash_pixmap.fill(Qt.GlobalColor.transparent)

    painter = QPainter(splash_pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)

    bg_rect = QRectF(0, 0, 400, 250)
    painter.setBrush(QColor(THEME.get_colors()['surface']))
    painter.setPen(Qt.PenStyle.NoPen)
    painter.drawRoundedRect(bg_rect, 16.0, 16.0)

    logo_path = get_resource_path("hatch_logo.png")
    logo_pixmap = QPixmap(logo_path)

    painter.setPen(QColor(THEME.get_colors()['text']))

    if not logo_pixmap.isNull():
        logo_scaled = logo_pixmap.scaledToHeight(60, Qt.TransformationMode.SmoothTransformation)
        x = (400 - logo_scaled.width()) // 2
        y = 70
        painter.drawPixmap(x, y, logo_scaled)

        painter.setFont(QFont("Source Sans Pro", 14, QFont.Weight.Bold))
        painter.drawText(QRectF(0, 150, 400, 40), Qt.AlignmentFlag.AlignCenter, f"ROAM Observation Logger v{CURRENT_VERSION}")
    else:
        painter.setFont(QFont("Source Sans Pro", 24, QFont.Weight.Bold))
        painter.drawText(QRectF(0, 0, 400, 250), Qt.AlignmentFlag.AlignCenter, f"HATCH ROAM\nROAM Observation Logger v{CURRENT_VERSION}")

    painter.end()

    splash = QSplashScreen(splash_pixmap, Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.FramelessWindowHint)
    splash.show()
    app.processEvents()

    window = MainWindow()

    def handle_new_connection():
        window._active_client = server.nextPendingConnection()

        def read_data():
            if window._active_client.readAll().data() == b"WAKE_UP":
                window.showNormal()
                window.activateWindow()
                window.raise_()
            window._active_client.disconnectFromHost()

        window._active_client.readyRead.connect(read_data)

    server.newConnection.connect(handle_new_connection)

    def show_main():
        splash.finish(window)
        window.show()

    QTimer.singleShot(800, show_main)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
