# theme.py
from PySide6.QtCore import QObject, Signal, Qt
from PySide6.QtGui import QGuiApplication, QPalette
from PySide6.QtWidgets import QApplication

class ThemeManager(QObject):
    theme_changed = Signal(dict)

    def __init__(self):
        super().__init__()
        self.is_dark = False

    def setup_system_theme_sync(self):
        self.is_dark = self.detect_system_dark_mode()
        if hasattr(QGuiApplication.styleHints(), 'colorSchemeChanged'):
            QGuiApplication.styleHints().colorSchemeChanged.connect(self.on_system_theme_changed)

    def detect_system_dark_mode(self):
        try:
            if hasattr(QGuiApplication.styleHints(), 'colorScheme'):
                return QGuiApplication.styleHints().colorScheme() == Qt.ColorScheme.Dark
            else:
                palette = QApplication.palette()
                return palette.color(QPalette.ColorRole.Window).lightness() < 128
        except Exception:
            return False

    def on_system_theme_changed(self, scheme):
        self.is_dark = (scheme == Qt.ColorScheme.Dark)
        self.theme_changed.emit(self.get_colors())

    def get_colors(self):
        if self.is_dark:
            return {
                "bg": "#1A1A1A",            
                "surface": "#2E2E2E",       
                "surface_hover": "#434343", 
                "border": "#595959",        
                "text": "#FAFAFA",          
                "text_muted": "#BFBFBF",    
                "orange": "#E84A37",        
                "primary": "#425563",       
                "primary_hover": "#5C768A", 
                "primary_pressed": "#839BAC",
                "track": "#595959",         
                "input_bg": "#1A1A1A",      
                "input_text": "#FFFFFF",    
                "shadow": "#000000",        
                "danger_bg": "#4A0000",
                "danger_border": "#7A0000",
                "danger_text": "#FFB3B3",
                "success": "#1A7F37",
                "hatch_blue": "#0D8BFF",
                "ai_result_bg": "#3A3A3A",
                "ai_highlight_bg": "#2C3B2C" # Dark mode sage green
            }
        else:
            return {
                "bg": "#FAFAFA",            
                "surface": "#F0F0F0",       
                "surface_hover": "#D9D9D9", 
                "border": "#BFBFBF",        
                "text": "#2E2E2E",          
                "text_muted": "#595959",    
                "orange": "#E84A37",        
                "primary": "#425563",       
                "primary_hover": "#2F3C46", 
                "primary_pressed": "#1C242A",
                "track": "#8C8C8C",         
                "input_bg": "#FFFFFF",      
                "input_text": "#2E2E2E",    
                "shadow": "#D9D9D9",        
                "danger_bg": "#FFEBED",     
                "danger_border": "#FFCECB", 
                "danger_text": "#CF222E",
                "success": "#1A7F37",
                "hatch_blue": "#0D8BFF",
                "ai_result_bg": "#EAEAEA",
                "ai_highlight_bg": "#DCE8DC" # Light mode sage green
            }

THEME = ThemeManager()
