# widgets.py
import os
import random
import math
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QSlider,
    QTextEdit, QAbstractButton, QSizePolicy, QButtonGroup, QComboBox,
    QLineEdit, QCompleter, QDialog, QCalendarWidget, QTimeEdit, QTableWidget,
    QTableWidgetItem, QApplication
)
from PySide6.QtCore import Qt, QTimer, QPropertyAnimation, Property, QRectF, QUrl, QDate, QTime, Signal
from PySide6.QtGui import QFont, QColor, QPainter, QPen, QTextCharFormat, QKeySequence, QTransform
from PySide6.QtMultimedia import QMediaPlayer, QAudioOutput
from theme import THEME

class SpinningProgressWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedSize(24, 24)
        self.angle = 0
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.rotate)
        self.timer.start(30)
        self.hide()

    def rotate(self):
        self.angle = (self.angle + 10) % 360
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QPen(QColor(THEME.get_colors()['primary']), 3, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
        
        rect = self.rect().adjusted(4, 4, -4, -4)
        painter.drawArc(rect, self.angle * 16, 270 * 16)

class VoiceWaveWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedSize(80, 40)
        self.bars = [5, 5, 5, 5, 5]
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.update_wave)
        
    def start(self):
        self.timer.start(100)
        self.show()
        
    def stop(self):
        self.timer.stop()
        self.bars = [5, 5, 5, 5, 5]
        self.update()
        self.hide()

    def update_wave(self):
        self.bars = [random.randint(6, 36) for _ in range(5)]
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        
        bg_rect = QRectF(0, 0, self.width(), self.height())
        painter.setBrush(QColor(0, 0, 0, 150))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawRoundedRect(bg_rect, 8.0, 8.0)
        
        painter.setBrush(QColor("#0D8BFF"))
        bar_width = 6
        spacing = 6
        total_width = (5 * bar_width) + (4 * spacing)
        start_x = (self.width() - total_width) / 2
        
        for i, height in enumerate(self.bars):
            x = start_x + i * (bar_width + spacing)
            y = (self.height() - height) / 2
            painter.drawRoundedRect(QRectF(x, y, bar_width, height), 2, 2)


class AudioPlayerWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(4, 0, 8, 0)
        layout.setSpacing(8)

        self.btn_play = QPushButton("▶", self)
        self.btn_play.setFixedSize(26, 26)
        self.btn_play.setCursor(Qt.CursorShape.PointingHandCursor)
        self._style_play_button()

        self.lbl_current = QLabel("0s")
        self.lbl_current.setStyleSheet("color: #8C8C8C; font-size: 11px; font-weight: bold;")
        self.lbl_current.setFixedWidth(20)
        self.lbl_current.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setCursor(Qt.CursorShape.PointingHandCursor)
        self.slider.setStyleSheet("""
            QSlider::groove:horizontal {
                border: none;
                height: 4px;
                background: #D9D9D9;
                border-radius: 2px;
            }
            QSlider::handle:horizontal {
                background: #8C8C8C;
                width: 10px;
                height: 10px;
                margin: -3px 0;
                border-radius: 5px;
            }
        """)

        self.lbl_total = QLabel("0s")
        self.lbl_total.setStyleSheet("color: #8C8C8C; font-size: 11px; font-weight: bold;")
        self.lbl_total.setFixedWidth(24)

        layout.addWidget(self.btn_play)
        layout.addWidget(self.lbl_current)
        layout.addWidget(self.slider)
        layout.addWidget(self.lbl_total)

        self.player = QMediaPlayer(self)
        self.audio_output = QAudioOutput(self)
        self.player.setAudioOutput(self.audio_output)

        self.btn_play.clicked.connect(self.toggle_playback)
        self.player.positionChanged.connect(self.update_position)
        self.player.durationChanged.connect(self.update_duration)
        self.player.playbackStateChanged.connect(self.update_state)
        self.slider.sliderMoved.connect(self.player.setPosition)

    def _style_play_button(self):
        self.btn_play.setStyleSheet("""
            QPushButton {
                border-radius: 13px;
                background-color: #D9D9D9;
                color: #2E2E2E;
                font-size: 12px;
                padding-left: 3px;
                padding-bottom: 1px;
            }
            QPushButton:hover { background-color: #BFBFBF; }
        """)

    def _style_pause_button(self):
        self.btn_play.setStyleSheet("""
            QPushButton {
                border-radius: 13px;
                background-color: #D9D9D9;
                color: #2E2E2E;
                font-size: 11px;
                padding-left: 0px; 
                padding-bottom: 0px;
            }
            QPushButton:hover { background-color: #BFBFBF; }
        """)

    def set_audio(self, path):
        if path and os.path.exists(path):
            self.player.setSource(QUrl.fromLocalFile(path))
            self.show()
        else:
            self.player.setSource(QUrl())
            self.hide()

    def toggle_playback(self):
        if self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self.player.pause()
        else:
            if self.player.position() == self.player.duration() and self.player.duration() > 0:
                self.player.setPosition(0)
            self.player.play()

    def update_state(self, state):
        if state == QMediaPlayer.PlaybackState.PlayingState:
            self.btn_play.setText("⏸")
            self._style_pause_button()
        else:
            self.btn_play.setText("▶")
            self._style_play_button()

    def update_position(self, pos):
        if not self.slider.isSliderDown():
            self.slider.setValue(pos)
        self.lbl_current.setText(f"{pos // 1000}s")

    def update_duration(self, duration):
        if duration > 0:
            self.slider.setRange(0, duration)
            self.lbl_total.setText(f"{duration // 1000}s")


class OverlayTextEdit(QTextEdit):
    submit_requested = Signal()

    def __init__(self, parent=None, enable_audio=True):
        super().__init__(parent)
        self.wave_widget = VoiceWaveWidget(self)
        self.wave_widget.hide()
        
        self.progress_widget = SpinningProgressWidget(self)
        self.progress_widget.hide()
        
        self.enable_audio = enable_audio
        if self.enable_audio:
            self.audio_player_widget = AudioPlayerWidget(self)
            self.audio_player_widget.hide()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Return or event.key() == Qt.Key.Key_Enter:
            if event.modifiers() & Qt.KeyboardModifier.AltModifier:
                self.insertPlainText("\n")
            else:
                self.submit_requested.emit()
                event.accept()
        else:
            super().keyPressEvent(event)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.wave_widget.move(
            (self.width() - self.wave_widget.width()) // 2,
            (self.height() - self.wave_widget.height()) // 2
        )
        self.progress_widget.move(
            (self.width() - self.progress_widget.width()) // 2,
            self.height() - 30
        )
        
        if self.enable_audio:
            self.audio_player_widget.setGeometry(4, self.height() - 36, 180, 32)

    def set_audio_path(self, path):
        if self.enable_audio:
            self.audio_player_widget.set_audio(path)


class AppleToggleSwitch(QAbstractButton):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setCheckable(True)
        self.setFixedSize(50, 28)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._position = 0.0
        self.colors = THEME.get_colors()
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.toggled.connect(self._on_toggled)
        THEME.theme_changed.connect(self.apply_theme)

    def apply_theme(self, c):
        self.colors = c
        self.update()

    @Property(float)
    def position(self):
        return self._position

    @position.setter
    def position(self, pos):
        self._position = pos
        self.update()

    def _on_toggled(self, checked):
        self.anim = QPropertyAnimation(self, b"position")
        self.anim.setEndValue(1.0 if checked else 0.0)
        self.anim.setDuration(150)
        self.anim.start()

    def set_highlight(self, active, color):
        self.highlight_active = active
        self.highlight_color = color
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        
        w = self.width()
        h = self.height()
        
        margin = 6 
        sw = w - 2 * margin
        sh = h - 2 * margin
        radius = sh / 2.0 
        
        rect = QRectF(margin, margin, sw, sh)
        p.setPen(Qt.PenStyle.NoPen)
        bg_color = QColor(self.colors["orange"]) if self.isChecked() else QColor(self.colors["track"])
        p.setBrush(bg_color)
        p.drawRoundedRect(rect, radius, radius)
        
        p.setFont(QFont("Source Sans Pro", 7, QFont.Weight.Bold))
        if self.isChecked():
            p.setPen(QColor("#FFFFFF"))
            text_rect = QRectF(margin + 6, margin, sw / 2, sh)
            p.drawText(text_rect, Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, "Yes")
        else:
            p.setPen(QColor("#FFFFFF")) 
            text_rect = QRectF(margin + sw / 2, margin, sw / 2 - 6, sh)
            p.drawText(text_rect, Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight, "No")
        
        thumb_size = sh - 4
        thumb_x = margin + 2 + self._position * (sw - thumb_size - 4)
        thumb_rect = QRectF(thumb_x, margin + 2, thumb_size, thumb_size)
        p.setBrush(QColor("#FFFFFF"))
        p.drawEllipse(thumb_rect)
        
        if getattr(self, 'highlight_active', False):
            p.setPen(QPen(QColor(self.highlight_color), 3))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(QRectF(1.5, 1.5, w-3, h-3), h/2.0, h/2.0)
        elif self.hasFocus():
            p.setPen(QPen(QColor(self.colors["text_muted"]), 3))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(QRectF(1.5, 1.5, w-3, h-3), h/2.0, h/2.0)


class LabeledSwitch(QWidget):
    def __init__(self, title, start_on=False, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)
        self.setMinimumHeight(28)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        
        self.label = QLabel(title)
        self.label.setFont(QFont("Source Sans Pro", 11, QFont.Weight.Normal))
        self.label.setWordWrap(True) 
        
        self.switch = AppleToggleSwitch()
        self.switch.setChecked(start_on)
        self.switch._position = 1.0 if start_on else 0.0
        
        layout.addWidget(self.label, alignment=Qt.AlignmentFlag.AlignVCenter)
        layout.addWidget(self.switch, alignment=Qt.AlignmentFlag.AlignVCenter)
        
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def apply_theme(self, c):
        font_weight = "bold" if THEME.is_dark else "normal"
        self.label.setStyleSheet(f"color: {c['text']}; padding: 0px; margin: 0px; font-weight: {font_weight};")
        
    def set_highlight(self, active, color):
        self.switch.set_highlight(active, color)

    def get_selected(self):
        return "Yes" if self.switch.isChecked() else "No"

    def set_selected(self, choice):
        self.switch.setChecked(choice == "Yes")


class AppleSegmentedControl(QWidget):
    def __init__(self, choices=[], start_choice=None, parent=None):
        super().__init__(parent)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setMinimumHeight(28) 
        self._ai_highlighted = False
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
            
        self.bg_widget = QWidget()
        self.bg_widget.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        bg_layout = QHBoxLayout(self.bg_widget)
        bg_layout.setContentsMargins(2, 2, 2, 2)
        bg_layout.setSpacing(2) 
        
        self._group = QButtonGroup(self)
        self._group.setExclusive(True)
        self._buttons = []
        
        for i, choice in enumerate(choices):
            btn = QPushButton(choice)
            btn.setCheckable(True)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            btn.setFixedHeight(24)
            
            self._group.addButton(btn, i)
            self._buttons.append(btn)
            bg_layout.addWidget(btn)
            
            if choice == start_choice:
                btn.setChecked(True)
                
        if start_choice is None and self._buttons:
            self._buttons[0].setChecked(True)
            
        layout.addWidget(self.bg_widget)
        
        self._group.buttonClicked.connect(self._clear_highlight)
        
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def _clear_highlight(self):
        if self._ai_highlighted:
            self.set_ai_highlight(False)

    def apply_theme(self, c):
        self.colors = c
        self.bg_widget.setStyleSheet(f"background-color: {c['border']}; border-radius: 6px;")
        bg_checked = c['ai_highlight_bg'] if self._ai_highlighted else c['input_bg']
        
        for btn in self._buttons:
            btn.setStyleSheet(f"""
                QPushButton {{
                    background-color: rgba(130, 130, 130, 0.1);
                    border: 1px solid rgba(130, 130, 130, 0.3);
                    border-radius: 4px; 
                    color: {c['text']}; 
                    font-family: 'Source Sans Pro', Arial, sans-serif;
                    font-weight: bold;
                    font-size: 11px;
                    padding: 2px 8px;
                }}
                QPushButton:checked {{
                    background-color: {bg_checked};
                    border: 1px solid {c['text_muted']};
                }}
                QPushButton:hover:!checked {{ background-color: rgba(130, 130, 130, 0.25); }}
            """)

    def set_ai_highlight(self, active):
        self._ai_highlighted = active
        self.apply_theme(self.colors)

    def set_highlight(self, active, color):
        if active:
            self.bg_widget.setStyleSheet(f"background-color: {self.colors['border']}; border: 2px solid {color}; border-radius: 6px;")
        else:
            self.bg_widget.setStyleSheet(f"background-color: {self.colors['border']}; border-radius: 6px;")

    def get_selected(self):
        for btn in self._buttons:
            if btn.isChecked():
                return btn.text()
        return None

    def set_selected(self, choice):
        for btn in self._buttons:
            if btn.text() == choice:
                btn.setChecked(True)
                break


class CompactLineEdit(QLineEdit):
    def __init__(self, placeholder="", parent=None):
        super().__init__(parent)
        self.setPlaceholderText(placeholder)
        self.setFont(QFont("Source Sans Pro", 11))
        self.setMinimumHeight(28)
        self.setAlignment(Qt.AlignmentFlag.AlignLeft)
        self._ai_highlighted = False
        
        self.textEdited.connect(self._clear_highlight)
        
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())
        
    def _clear_highlight(self):
        if self._ai_highlighted:
            self.set_ai_highlight(False)
            
    def set_ai_highlight(self, active):
        self._ai_highlighted = active
        self.apply_theme(THEME.get_colors())
        
    def focusOutEvent(self, event):
        super().focusOutEvent(event)
        self.setCursorPosition(0)
        
    def setText(self, text):
        super().setText(text)
        self.setCursorPosition(0)

    def apply_theme(self, c):
        bg = c['ai_highlight_bg'] if self._ai_highlighted else c['input_bg']
        self.setStyleSheet(f"""
            QLineEdit {{
                padding: 4px 8px;
                border: 1px solid {c['border']};
                border-radius: 4px; 
                background-color: {bg};
                color: {c['input_text']};
            }}
            QLineEdit:focus {{ border-color: {c['orange']}; }}
            QLineEdit::placeholder {{ color: {c['text_muted']}; }}
        """)


class CompactComboBox(QComboBox):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFont(QFont("Source Sans Pro", 11))
        self.setMinimumHeight(28)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self._ai_highlighted = False
        
        self.currentTextChanged.connect(self._clear_highlight)
        
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def _clear_highlight(self):
        if self._ai_highlighted:
            self.set_ai_highlight(False)

    def set_ai_highlight(self, active):
        self._ai_highlighted = active
        self.apply_theme(THEME.get_colors())

    def apply_theme(self, c):
        bg = c['ai_highlight_bg'] if self._ai_highlighted else c['input_bg']
        self.setStyleSheet(f"""
            QComboBox {{
                padding: 4px 8px;
                border: 1px solid {c['border']};
                border-radius: 4px; 
                background-color: {bg};
                color: {c['input_text']};
            }}
            QComboBox:focus {{ border-color: {c['orange']}; }}
            QComboBox::drop-down {{ border: none; width: 24px; }}
            QComboBox QAbstractItemView {{
                background-color: {c['input_bg']};
                selection-background-color: {c['orange']};
                selection-color: #FFFFFF;
                color: {c['input_text']};
            }}
            QLineEdit::placeholder {{ color: {c['text_muted']}; }}
        """)


class SearchableComboBox(CompactComboBox):
    def __init__(self, items=[], parent=None):
        super().__init__(parent)
        self.setEditable(True)
        self.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self.setMaxVisibleItems(15) 
        
        self.completer_obj = QCompleter(items, self)
        self.completer_obj.setFilterMode(Qt.MatchFlag.MatchContains)
        self.completer_obj.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self.completer_obj.setCompletionMode(QCompleter.CompletionMode.PopupCompletion)
        self.completer_obj.setMaxVisibleItems(15) 
        
        self.setCompleter(self.completer_obj)
        self.addItems(items)
        self.lineEdit().setAlignment(Qt.AlignmentFlag.AlignLeft)
        
        self.lineEdit().textEdited.connect(self._clear_highlight)
        
        self._original_mouse_press = self.lineEdit().mousePressEvent
        self.lineEdit().mousePressEvent = self._custom_mouse_press
        
        def custom_text_edited(text):
            if not text or text == '*':
                self.showPopup()
        self.lineEdit().textEdited.connect(custom_text_edited)

        self._original_focus_in = self.lineEdit().focusInEvent
        self.lineEdit().focusInEvent = self._custom_focus_in

        self._original_focus_out = self.lineEdit().focusOutEvent
        self.lineEdit().focusOutEvent = self._custom_focus_out
        
        def handle_double_click(event):
            self._original_mouse_press(event)
            self.showPopup()
        self.lineEdit().mouseDoubleClickEvent = handle_double_click
        
        THEME.theme_changed.connect(self._apply_popup_theme)

    def _custom_mouse_press(self, event):
        self._original_mouse_press(event)
        self.showPopup()

    def _custom_focus_in(self, event):
        self._original_focus_in(event)
        QTimer.singleShot(0, self.showPopup)

    def _custom_focus_out(self, event):
        self._original_focus_out(event)
        self.lineEdit().setCursorPosition(0)

    def setCurrentText(self, text):
        super().setCurrentText(text)
        self.lineEdit().setCursorPosition(0)

    def _apply_popup_theme(self, c):
        self.completer_obj.popup().setFont(QFont("Source Sans Pro", 11))
        self.completer_obj.popup().setStyleSheet(f"""
            QListView {{
                background-color: {c['input_bg']};
                border: 1px solid {c['border']};
                border-radius: 4px; 
                selection-background-color: {c['orange']};
                color: {c['input_text']};
                padding: 4px;
            }}
            QListView::item {{ padding: 6px; border-radius: 4px; }}
        """)


class LockableComboBox(QWidget):
    def __init__(self, items=[], parent=None):
        super().__init__(parent)
        self.setMinimumHeight(28)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        self.combo = SearchableComboBox(items)
        self.lock_btn = QPushButton("Lock")
        self.lock_btn.setCheckable(True)
        self.lock_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.lock_btn.setFixedWidth(46)
        self.lock_btn.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Expanding)
        self.lock_btn.toggled.connect(self._on_lock_toggled)

        layout.addWidget(self.combo)
        layout.addWidget(self.lock_btn)

        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def _on_lock_toggled(self, checked):
        self.lock_btn.setText("Unlock" if checked else "Lock")
        self.combo.setEnabled(not checked)
        self.apply_theme(THEME.get_colors())

    def is_locked(self):
        return self.lock_btn.isChecked()

    def apply_theme(self, c):
        bg = c['surface_hover'] if self.lock_btn.isChecked() else c['input_bg']
        combo_bg = "#E0E0E0" if self.lock_btn.isChecked() and not THEME.is_dark else ("#3A3A3A" if self.lock_btn.isChecked() and THEME.is_dark else c['input_bg'])
        self.lock_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {bg}; border: 1px solid {c['border']}; 
                border-radius: 4px; color: {c['text']}; font-weight: bold; font-size: 11px;
                padding: 2px; margin: 0px;
            }}
            QPushButton:hover {{ background-color: {c['surface_hover']}; }}
        """)
        self.combo.setStyleSheet(self.combo.styleSheet() + f"QComboBox {{ background-color: {combo_bg}; }}")

    def currentText(self): return self.combo.currentText()
    def setCurrentText(self, text): self.combo.setCurrentText(text)
    def set_ai_highlight(self, active): self.combo.set_ai_highlight(active)
    def setEnabled(self, enabled):
        self.lock_btn.setEnabled(enabled)
        if not self.is_locked():
            self.combo.setEnabled(enabled)
    def styleSheet(self): return self.combo.styleSheet()
    def setStyleSheet(self, style): self.combo.setStyleSheet(style)
    def lineEdit(self): return self.combo.lineEdit()


class CompactDateEdit(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(28)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self._ai_highlighted = False
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        self.date_edit = CompactLineEdit()
        self.date_edit.setReadOnly(True)
        self.date_edit.setCursor(Qt.CursorShape.PointingHandCursor)
        self.date_edit.setText(QDate.currentDate().toString("dd MMMM yyyy"))
        self.date_edit.mousePressEvent = self._mouse_press_event

        self.today_btn = QPushButton("Today")
        self.today_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.today_btn.setFixedWidth(46)
        self.today_btn.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Expanding)
        self.today_btn.clicked.connect(self.set_to_today)

        layout.addWidget(self.date_edit)
        layout.addWidget(self.today_btn)

        self.popup = None
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def _mouse_press_event(self, event):
        QLineEdit.mousePressEvent(self.date_edit, event)
        self.show_calendar()

    def show_calendar(self):
        c = THEME.get_colors()
        if not self.popup:
            self.popup = QDialog(self, Qt.WindowType.Popup | Qt.WindowType.FramelessWindowHint)
            layout = QVBoxLayout(self.popup)
            layout.setContentsMargins(0, 0, 0, 0)
            
            self.calendar = QCalendarWidget(self.popup)
            self.calendar.setGridVisible(True)
            self.calendar.clicked.connect(self._date_selected)
            layout.addWidget(self.calendar)
            
        self.calendar.setStyleSheet(f"""
            QCalendarWidget QWidget {{ 
                background-color: {c['bg']}; color: {c['text']}; 
            }}
            QCalendarWidget QAbstractItemView:enabled {{
                color: {c['input_text']}; background-color: {c['input_bg']};
                selection-background-color: {c['orange']};
            }}
        """)

        fmt = QTextCharFormat()
        fmt.setBackground(QColor(c['hatch_blue']))
        fmt.setForeground(QColor("#FFFFFF"))
        fmt.setFontWeight(QFont.Weight.Bold)
        self.calendar.setDateTextFormat(QDate.currentDate(), fmt)
        
        current_date = QDate.fromString(self.date_edit.text(), "dd MMMM yyyy")
        if current_date.isValid():
            self.calendar.setSelectedDate(current_date)
        
        pos = self.date_edit.mapToGlobal(self.date_edit.rect().bottomLeft())
        self.popup.move(pos)
        self.popup.show()

    def _date_selected(self, date):
        self.date_edit.setText(date.toString("dd MMMM yyyy"))
        self.date_edit.setCursorPosition(0)
        self.popup.hide()
        self._clear_highlight()

    def set_to_today(self):
        self.date_edit.setText(QDate.currentDate().toString("dd MMMM yyyy"))
        self.date_edit.setCursorPosition(0)
        self._clear_highlight()

    def _clear_highlight(self):
        if self._ai_highlighted:
            self.set_ai_highlight(False)

    def set_ai_highlight(self, active):
        self._ai_highlighted = active
        self.date_edit.set_ai_highlight(active)

    def apply_theme(self, c):
        self.today_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {c['input_bg']}; border: 1px solid {c['border']}; 
                border-radius: 4px; color: {c['text']}; font-weight: bold; font-size: 11px;
                padding: 2px; margin: 0px;
            }}
            QPushButton:hover {{ background-color: {c['surface_hover']}; }}
        """)

    def date(self):
        return QDate.fromString(self.date_edit.text(), "dd MMMM yyyy")

    def setDate(self, date):
        self.date_edit.setText(date.toString("dd MMMM yyyy"))
        self.date_edit.setCursorPosition(0)
        
    def setEnabled(self, enabled):
        self.date_edit.setEnabled(enabled)
        self.today_btn.setEnabled(enabled)


class CompactTimeEdit(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(28)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self._ai_highlighted = False
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        self.time_edit = QTimeEdit()
        self.time_edit.setDisplayFormat("HH:mm")
        self.time_edit.setTime(QTime.currentTime())
        self.time_edit.setButtonSymbols(QTimeEdit.ButtonSymbols.NoButtons)
        self.time_edit.setFont(QFont("Source Sans Pro", 11))
        self.time_edit.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.time_edit.setAlignment(Qt.AlignmentFlag.AlignLeft)
        
        self.time_edit.timeChanged.connect(self._clear_highlight)

        self.now_btn = QPushButton("Now")
        self.now_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.now_btn.setFixedWidth(46)
        self.now_btn.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Expanding)
        self.now_btn.clicked.connect(self.set_to_now)

        layout.addWidget(self.time_edit)
        layout.addWidget(self.now_btn)

        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def _clear_highlight(self):
        if self._ai_highlighted:
            self.set_ai_highlight(False)

    def set_ai_highlight(self, active):
        self._ai_highlighted = active
        self.apply_theme(THEME.get_colors())

    def apply_theme(self, c):
        bg = c['ai_highlight_bg'] if self._ai_highlighted else c['input_bg']
        self.time_edit.setStyleSheet(f"""
            QTimeEdit {{
                padding: 4px 8px; border: 1px solid {c['border']};
                border-radius: 4px; background-color: {bg}; color: {c['input_text']};
            }}
            QTimeEdit:focus {{ border-color: {c['orange']}; }}
        """)
        self.now_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {c['input_bg']}; border: 1px solid {c['border']}; 
                border-radius: 4px; color: {c['text']}; font-weight: bold; font-size: 11px;
                padding: 2px; margin: 0px;
            }}
            QPushButton:hover {{ background-color: {c['surface_hover']}; }}
        """)

    def set_to_now(self):
        self.time_edit.setTime(QTime.currentTime())
        self._clear_highlight()

    def time(self):
        return self.time_edit.time()

    def setTime(self, t):
        self.time_edit.setTime(t)


class SelectableTag(QPushButton):
    def __init__(self, text, bg_color, fg_color="#FFFFFF", parent=None):
        super().__init__(text, parent)
        self._active_bg = bg_color
        self._active_fg = fg_color
        self._ai_highlighted = False
        self.setCheckable(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFont(QFont("Source Sans Pro", 11, QFont.Weight.Bold))
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def apply_theme(self, c):
        self._inactive_bg = c['surface']
        self._inactive_fg = c['text_muted']
        self._inactive_border = c['border']
        self._refresh()

    def set_ai_highlight(self, active):
        self._ai_highlighted = active
        self._refresh()

    def set_highlight(self, active, color):
        self.highlight_active = active
        self.highlight_color = color
        self._refresh()

    def _refresh(self):
        c = THEME.get_colors()
        
        if self.isChecked() and self._ai_highlighted:
            bg = c['ai_highlight_bg']
            fg = c['text']
        else:
            bg = self._active_bg if self.isChecked() else self._inactive_bg
            fg = self._active_fg if self.isChecked() else self._inactive_fg
        
        is_highlighted = getattr(self, 'highlight_active', False) and self.isChecked()
        border = getattr(self, 'highlight_color', '') if is_highlighted else (self._active_bg if self.isChecked() else self._inactive_border)
        bw = "2px" if is_highlighted else "1px"
        
        hover_bg = self._active_bg if self.isChecked() else c['surface_hover']
            
        self.setStyleSheet(f"""
            QPushButton {{
                background-color: {bg}; color: {fg}; padding: 6px 12px;
                border-radius: 8px; min-width: 60px; border: {bw} solid {border};
            }}
            QPushButton:hover {{
                background-color: {hover_bg};
                border: {bw} solid {c['text'] if not self.isChecked() else border};
            }}
        """)

    def setChecked(self, checked: bool) -> None:
        super().setChecked(checked)
        self._refresh()


class CardTypeSelector(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8) 

        self.btn_design = SelectableTag("Design", "#F3C200", "#1A1A1A") 
        self.btn_field = SelectableTag("Field", "#1A7F37", "#FFFFFF")   
        self.btn_office = SelectableTag("Office", "#0D8BFF", "#FFFFFF") 

        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        
        for i, btn in enumerate([self.btn_design, self.btn_field, self.btn_office]):
            self.group.addButton(btn, i)
            btn.clicked.connect(self._update_indicators)
            layout.addWidget(btn)
        
        self.btn_field.setChecked(True)

    def set_ai_highlight(self, active):
        for btn in [self.btn_design, self.btn_field, self.btn_office]:
            btn.set_ai_highlight(active)

    def set_highlight(self, active, color):
        for btn in [self.btn_design, self.btn_field, self.btn_office]:
            btn.set_highlight(active, color)

    def _update_indicators(self):
        self.set_ai_highlight(False)
        for btn in [self.btn_design, self.btn_field, self.btn_office]:
            btn._refresh()
            
    def get_selected(self):
        mapping = {0: "Design", 1: "Field", 2: "Office"}
        return mapping.get(self.group.checkedId(), "Field")
        
    def set_selected(self, val):
        val_lower = str(val).lower()
        if "design" in val_lower:
            btn = self.btn_design
        elif "office" in val_lower:
            btn = self.btn_office
        else:
            btn = self.btn_field
            
        btn.setChecked(True)
        self._update_indicators()


class ExcelPasteTable(QTableWidget):
    def __init__(self, rows, columns, parent=None):
        super().__init__(rows, columns, parent)
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())
        
    def apply_theme(self, c):
        self.setStyleSheet(f"""
            QTableWidget {{
                background-color: {c['input_bg']}; color: {c['input_text']};
                gridline-color: {c['border']}; border: 1px solid {c['border']};
            }}
            QHeaderView::section {{
                background-color: {c['surface']}; color: {c['text']};
                border: 1px solid {c['border']}; font-weight: bold;
            }}
        """)

    def keyPressEvent(self, event):
        if event.matches(QKeySequence.StandardKey.Copy):
            self.copy_to_clipboard()
        elif event.matches(QKeySequence.StandardKey.Paste):
            self.paste_from_clipboard()
        elif event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            self.blockSignals(True)
            for item in self.selectedItems():
                item.setText("")
            self.blockSignals(False)
            curr = self.currentItem()
            if curr:
                self.itemChanged.emit(curr)
        else:
            super().keyPressEvent(event)
            
    def copy_to_clipboard(self):
        selection = self.selectedIndexes()
        if not selection:
            return
            
        selection.sort(key=lambda index: (index.row(), index.column()))
        min_row = selection[0].row()
        max_row = selection[-1].row()
        min_col = min([index.column() for index in selection])
        max_col = max([index.column() for index in selection])
        
        copy_text = ""
        for row in range(min_row, max_row + 1):
            row_data = []
            for col in range(min_col, max_col + 1):
                item = self.item(row, col)
                row_data.append(item.text().strip() if item else "")
            copy_text += "\t".join(row_data)
            if row < max_row:
                copy_text += "\n"
                
        QApplication.clipboard().setText(copy_text)

    def paste_from_clipboard(self):
        text = QApplication.clipboard().text()
        if not text: return
        rows = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
        if rows and not rows[-1]: rows = rows[:-1]

        selected = self.selectedIndexes()
        
        if len(rows) == 1 and "\t" not in rows[0] and len(selected) > 1:
            self.blockSignals(True)
            for index in selected:
                item = self.item(index.row(), index.column())
                if not item:
                    item = QTableWidgetItem()
                    self.setItem(index.row(), index.column(), item)
                item.setText(rows[0].strip())
            self.blockSignals(False)
            if selected:
                self.itemChanged.emit(self.item(selected[0].row(), selected[0].column()))
            return

        current_row, current_col = max(0, self.currentRow()), max(0, self.currentColumn())
        max_cols = current_col + max(len(r.split('\t')) for r in rows)
        if max_cols > self.columnCount():
            self.setColumnCount(max_cols)
            self.setHorizontalHeaderLabels([f"VFL {i+1}" for i in range(self.columnCount())])

        self.blockSignals(True)
        for r_idx, row_data in enumerate(rows):
            target_row = current_row + r_idx
            if target_row >= self.rowCount(): break
            for c_idx, col_data in enumerate(row_data.split('\t')):
                target_col = current_col + c_idx
                item = self.item(target_row, target_col)
                if not item:
                    item = QTableWidgetItem()
                    self.setItem(target_row, target_col, item)
                item.setText(col_data.strip())
        self.blockSignals(False)
        
        it = self.item(current_row, current_col)
        if it:
            self.itemChanged.emit(it)
