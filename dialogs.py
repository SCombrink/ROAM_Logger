# dialogs.py
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QTextEdit,
    QPushButton, QMessageBox, QWidget, QFrame, QApplication, QGraphicsOpacityEffect, QProgressBar, QSizePolicy
)
from PySide6.QtCore import Qt, QPropertyAnimation
from PySide6.QtGui import QFont, QColor
from theme import THEME
from workers import VoiceWorker, PersistentCopilotWorker # <-- Use PersistentCopilotWorker
from widgets import OverlayTextEdit

class LocationPromptDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Missing Location Info")
        self.setFixedSize(500, 320)
        self.extra_info = ""
        self.is_recording = False
        self.voice_worker = None
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 16)
        layout.setSpacing(8)
        
        lbl = QLabel("Copilot couldn't extract an exact location.\nPlease provide more details below:")
        lbl.setFont(QFont("Source Sans Pro", 11, QFont.Weight.Bold))
        layout.addWidget(lbl)
        
        self.ai_container = QWidget()
        ai_layout = QVBoxLayout(self.ai_container)
        ai_layout.setContentsMargins(0, 0, 0, 0)
        ai_layout.setSpacing(0)
        
        self.prompt_area = OverlayTextEdit(enable_audio=False)
        self.prompt_area.setPlaceholderText("Example: Working on the 2nd floor server room in the Greenstone office...")
        self.prompt_area.setFixedHeight(140)
        self.prompt_area.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        ai_layout.addWidget(self.prompt_area)
        
        btn_container = QWidget()
        btn_layout = QHBoxLayout(btn_container)
        btn_layout.setContentsMargins(0, 0, 0, 0)
        btn_layout.setSpacing(0)
        
        self.btn_voice = QPushButton("Start Recording")
        self.btn_submit = QPushButton("Submit Prompt")
        self.btn_voice.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_submit.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_voice.setFixedHeight(36)
        self.btn_submit.setFixedHeight(36)
        
        self.btn_voice.clicked.connect(self.on_voice_click)
        self.btn_submit.clicked.connect(self.on_submit_click)
        
        btn_layout.addWidget(self.btn_voice)
        btn_layout.addWidget(self.btn_submit)
        ai_layout.addWidget(btn_container)
        
        layout.addWidget(self.ai_container)
        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(THEME.get_colors())

    def apply_theme(self, c):
        self.setStyleSheet(f"""
            QDialog {{ background-color: {c['bg']}; font-family: 'Source Sans Pro'; }}
            QLabel {{ color: {c['text']}; }}
        """)
        
        self.prompt_area.setStyleSheet(f"""
            QTextEdit {{
                background-color: {c['input_bg']}; color: {c['input_text']};
                border: 1px solid {c['border']}; border-bottom: none;
                border-top-left-radius: 8px; border-top-right-radius: 8px;
                border-bottom-left-radius: 0px; border-bottom-right-radius: 0px;
                padding: 8px; font-size: 12px;
            }}
            QTextEdit:focus {{ border-color: {c['hatch_blue']}; }}
        """)
        
        self.btn_voice.setStyleSheet(f"""
            QPushButton {{
                background-color: {c['surface']}; color: {c['text']};
                border: 1px solid {c['border']}; border-right: none;
                border-top-left-radius: 0px; border-top-right-radius: 0px;
                border-bottom-left-radius: 8px; border-bottom-right-radius: 0px;
                font-weight: bold; font-size: 12px;
            }}
            QPushButton:hover:!disabled {{ background-color: {c['surface_hover']}; }}
        """)
        
        self.btn_submit.setStyleSheet(f"""
            QPushButton {{
                background-color: {c['surface']}; color: {c['text']};
                border: 1px solid {c['border']};
                border-top-left-radius: 0px; border-top-right-radius: 0px;
                border-bottom-left-radius: 0px; border-bottom-right-radius: 8px;
                font-weight: bold; font-size: 12px;
            }}
            QPushButton:hover:!disabled {{ background-color: {c['surface_hover']}; }}
        """)

    def on_voice_click(self):
        if not self.is_recording:
            self.is_recording = True
            self.btn_voice.setText("Stop Recording")
            self.prompt_area.wave_widget.start()
            self.voice_worker = VoiceWorker()
            self.voice_worker.processing_signal.connect(self.on_voice_processing)
            self.voice_worker.ready_signal.connect(self.on_voice_ready)
            self.voice_worker.finished_signal.connect(self.on_voice_finished)
            self.voice_worker.start()
        else:
            self.stop_recording()

    def on_voice_ready(self):
        self.prompt_area.setPlaceholderText("Listening... Speak now.")

    def stop_recording(self):
        self.is_recording = False
        self.prompt_area.wave_widget.stop()
        if self.voice_worker and self.voice_worker.isRunning():
            self.btn_voice.setText("Converting...")
            self.voice_worker.stop()
        else:
            self.btn_voice.setText("Start Recording")
            self.prompt_area.setPlaceholderText("Example: Working on the 3rd floor server room at 121 Research Drive...")

    def on_voice_processing(self):
        self.btn_voice.setText("Converting...")

    def on_voice_finished(self, text, success, audio_path):
        self.is_recording = False
        self.btn_voice.setText("Start Recording")
        self.prompt_area.wave_widget.stop()
        self.prompt_area.setPlaceholderText("Example: Working on the 3rd floor server room at 121 Research Drive...")
        
        if success and text:
            current = self.prompt_area.toPlainText()
            self.prompt_area.setText(f"{current} {text}".strip())
        elif not success:
            QMessageBox.warning(self, "Voice Error", text)

    def on_submit_click(self):
        self.extra_info = self.prompt_area.toPlainText().strip()
        self.accept()
        
    def closeEvent(self, event):
        if self.is_recording:
            self.stop_recording()
        super().closeEvent(event)


class ProgressDialog(QDialog):
    def __init__(self, parent=None, title_text="Submitting Observation..."):
        super().__init__(parent)
        self.colors = THEME.get_colors()
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.Dialog)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setModal(True)

        self.frame = QFrame(self)
        self.frame.setObjectName("ProgressFrame")
        self.frame.setFixedSize(340, 220) 
        
        layout = QVBoxLayout(self.frame)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(12)
        
        main_layout = QVBoxLayout(self)
        main_layout.addWidget(self.frame, alignment=Qt.AlignmentFlag.AlignCenter)

        self.title = QLabel(title_text)
        self.title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.title.setWordWrap(True)
        layout.addWidget(self.title)
        
        self.stats_label = QLabel("")
        self.stats_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.stats_label.hide()
        layout.addWidget(self.stats_label)

        self.counts_layout = QHBoxLayout()
        self.counts_layout.setSpacing(16)
        
        self.succ_label = QLabel("")
        self.succ_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.succ_label.hide()
        
        self.fail_label = QLabel("")
        self.fail_label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        self.fail_label.hide()

        self.counts_layout.addWidget(self.succ_label)
        self.counts_layout.addWidget(self.fail_label)
        layout.addLayout(self.counts_layout)

        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 0)
        layout.addWidget(self.progress_bar)

        self.checkmark = QLabel("✔")
        self.checkmark.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.checkmark.hide()
        layout.addWidget(self.checkmark)

        btn_layout = QHBoxLayout()
        btn_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.cancel_btn = QPushButton("Cancel Submission")
        self.cancel_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        btn_layout.addWidget(self.cancel_btn)

        self.close_btn = QPushButton("Close")
        self.close_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.close_btn.clicked.connect(self.accept) 
        self.close_btn.hide()
        btn_layout.addWidget(self.close_btn)
        
        layout.addLayout(btn_layout)

        THEME.theme_changed.connect(self.apply_theme)
        self.apply_theme(self.colors)

    def apply_theme(self, c):
        self.colors = c
        self.frame.setStyleSheet(f"QFrame#ProgressFrame {{ background-color: {c['surface']}; border: 1px solid {c['border']}; border-radius: 12px; }}")
        self.title.setStyleSheet(f"font-size: 14px; font-weight: bold; color: {c['text']}; font-family: 'Source Sans Pro';")
        
        self.stats_label.setStyleSheet(f"font-size: 13px; color: {c['text_muted']}; font-family: 'Source Sans Pro'; margin-bottom: 4px;")
        self.succ_label.setStyleSheet(f"font-size: 13px; font-weight: bold; color: {c['success']}; font-family: 'Source Sans Pro';")
        self.fail_label.setStyleSheet(f"font-size: 13px; font-weight: bold; color: {c['danger_text']}; font-family: 'Source Sans Pro';")
        
        self.checkmark.setStyleSheet(f"color: {c['success']}; font-size: 32px; font-weight: bold; font-family: 'Segoe UI';")
        self.progress_bar.setStyleSheet(f"""
            QProgressBar {{ border: 1px solid {c['border']}; border-radius: 4px; height: 8px; color: transparent; }}
            QProgressBar::chunk {{ background-color: {c['primary']}; border-radius: 4px; }}
        """)
        self.cancel_btn.setStyleSheet(f"""
            QPushButton {{ padding: 6px 12px; border: 1px solid {c['border']}; border-radius: 4px; background-color: {c['surface_hover']}; color: {c['text']}; font-weight: bold; }}
            QPushButton:hover {{ background-color: {c['border']}; }}
        """)
        self.close_btn.setStyleSheet(f"""
            QPushButton {{ padding: 6px 12px; border: 1px solid {c['danger_border']}; border-radius: 4px; background-color: {c['danger_bg']}; color: {c['danger_text']}; font-weight: bold; }}
            QPushButton:hover {{ background-color: {c['danger_border']}; }}
        """)
        
    def update_counts(self, current, total, success, fail):
        self.stats_label.show()
        self.succ_label.show()
        self.fail_label.show()
        
        self.stats_label.setText(f"Processing VFL {current} of {total}")
        self.succ_label.setText(f"✅ Success: {success}")
        self.fail_label.setText(f"❌ Failed: {fail}")

    def show_success(self, message="Successfully Submitted!"):
        self.progress_bar.hide()
        self.cancel_btn.hide()
        self.stats_label.hide()
        self.succ_label.hide()
        self.fail_label.hide()
        
        self.title.setText(message)
        self.title.setStyleSheet(f"font-size: 15px; font-weight: bold; color: {self.colors['success']}; font-family: 'Source Sans Pro';")
        self.checkmark.show()
        
        self.close_btn.setText("Done")
        self.close_btn.setStyleSheet(f"""
            QPushButton {{ padding: 6px 12px; border-radius: 4px; background-color: {self.colors['success']}; color: #FFFFFF; font-weight: bold; border: none; }}
            QPushButton:hover {{ background-color: {self.colors['primary_pressed']}; opacity: 0.9; }}
        """)
        self.close_btn.show()
        
        self.effect = QGraphicsOpacityEffect()
        self.checkmark.setGraphicsEffect(self.effect)
        self.anim = QPropertyAnimation(self.effect, b"opacity")
        self.anim.setDuration(400)
        self.anim.setStartValue(0)
        self.anim.setEndValue(1)
        self.anim.start()

    def show_error(self, message="Submission Failed"):
        self.progress_bar.hide()
        self.checkmark.hide()
        self.cancel_btn.hide()
        self.stats_label.hide()
        self.succ_label.hide()
        self.fail_label.hide()
        
        self.title.setText(f"Failed to Submit:\n{message}")
        self.title.setStyleSheet(f"font-size: 12px; font-weight: bold; color: {self.colors['danger_text']}; font-family: 'Source Sans Pro';")
        self.close_btn.setText("Close")
        self.close_btn.show()
