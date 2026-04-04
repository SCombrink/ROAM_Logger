import os
import sys
import shutil
import subprocess
import threading
import tkinter as tk
from tkinter import messagebox
from tkinter.ttk import Progressbar, Style

# Required dependencies to install on the target machine
REQUIREMENTS = [
    "PySide6",
    "playwright",
    "requests"
]

def get_resource_path(relative_path):
    """Get absolute path to resource, works for dev and for PyInstaller"""
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

class InstallerGUI(tk.Tk):
    def __init__(self):
        super().__init__()
        
        self.title("Hatch Roam Logger - Installer")
        self.geometry("550x400")
        self.configure(bg="#1E1E1E")  # Match THEME bg
        self.resizable(False, False)
        
        # Set the window icon if it exists in the bundled folder
        icon_path = get_resource_path(os.path.join("Hatch Roam Logger", "roamicon.ico"))
        if os.path.exists(icon_path):
            try:
                self.iconbitmap(icon_path)
            except Exception:
                pass
        
        # Center window
        self.eval('tk::PlaceWindow . center')
        
        # Style configuration to match the main app
        style = Style()
        style.theme_use('clam')
        style.configure("TProgressbar", troughcolor="#2D2D2D", background="#0072CE", bordercolor="#444444", lightcolor="#0072CE", darkcolor="#0072CE")

        # UI Elements
        self.lbl_title = tk.Label(self, text="Hatch ROAM Logger Setup", font=("Arial", 16, "bold"), bg="#1E1E1E", fg="#FFFFFF")
        self.lbl_title.pack(pady=(20, 5))
        
        self.lbl_status = tk.Label(self, text="Ready to install...", font=("Arial", 11), bg="#1E1E1E", fg="#AAAAAA")
        self.lbl_status.pack(pady=(0, 15))
        
        self.progress = Progressbar(self, orient=tk.HORIZONTAL, length=450, mode='determinate', style="TProgressbar")
        self.progress.pack(pady=10)
        
        self.txt_log = tk.Text(self, height=10, width=65, bg="#2D2D2D", fg="#E0E0E0", font=("Consolas", 9), relief=tk.FLAT, state=tk.DISABLED)
        self.txt_log.pack(pady=10)
        
        self.btn_install = tk.Button(self, text="Install Now", font=("Arial", 11, "bold"), bg="#0072CE", fg="#FFFFFF", relief=tk.FLAT, activebackground="#005A9E", activeforeground="#FFFFFF", command=self.start_installation, width=20, pady=5)
        self.btn_install.pack(pady=(10, 20))

    def log(self, message):
        self.txt_log.config(state=tk.NORMAL)
        self.txt_log.insert(tk.END, message + "\n")
        self.txt_log.see(tk.END)
        self.txt_log.config(state=tk.DISABLED)
        self.update_idletasks()

    def update_status(self, text, progress_val=None):
        self.lbl_status.config(text=text)
        if progress_val is not None:
            self.progress['value'] = progress_val
        self.update_idletasks()

    def start_installation(self):
        self.btn_install.config(state=tk.DISABLED, bg="#444444")
        threading.Thread(target=self.run_installation_steps, daemon=True).start()

    def run_installation_steps(self):
        try:
            self.progress['maximum'] = 100
            
            # 1. Setup Directories
            self.update_status("Setting up directories...", 10)
            docs_dir = os.path.join(os.path.expanduser("~"), "Documents")
            app_dir = os.path.join(docs_dir, "Hatch Roam Logger")
            os.makedirs(app_dir, exist_ok=True)
            self.log(f"Created installation directory: {app_dir}")
            
            # 2. Extract and Copy the bundled app files
            self.update_status("Extracting application files...", 25)
            
            # The folder we bundled via PyInstaller --add-data
            bundled_app_dir = get_resource_path("Hatch Roam Logger")
            
            if os.path.exists(bundled_app_dir):
                # Copy everything from bundled_app_dir to app_dir
                shutil.copytree(bundled_app_dir, app_dir, dirs_exist_ok=True)
                self.log(f"Extracted files to {app_dir}")
            else:
                self.log(f"WARNING: Bundled 'Hatch Roam Logger' folder not found at {bundled_app_dir}. Skipping copy.")

            dest_exe = os.path.join(app_dir, "Hatch Roam Logger.exe")

            # 3. Install Python Dependencies
            self.update_status("Installing dependencies via pip...", 40)
            self.run_command([sys.executable, "-m", "pip", "install", "--upgrade", "pip"])
            
            total_reqs = len(REQUIREMENTS)
            for i, req in enumerate(REQUIREMENTS):
                self.update_status(f"Installing {req}...", 40 + int(30 * (i / total_reqs)))
                self.run_command([sys.executable, "-m", "pip", "install", req])

            # 4. Install Playwright Browsers
            self.update_status("Installing Playwright browser engine...", 80)
            self.run_command([sys.executable, "-m", "playwright", "install", "msedge"])

            self.update_status("Installation Complete!", 100)
            self.log("All dependencies installed successfully.")
            
            # Create a basic desktop shortcut
            if os.path.exists(dest_exe):
                self.create_shortcut(dest_exe)
            
            messagebox.showinfo("Success", "Hatch Roam Logger has been installed successfully in your Documents folder!")
            self.destroy()

        except Exception as e:
            self.log(f"ERROR: {str(e)}")
            self.update_status("Installation failed.", 0)
            messagebox.showerror("Error", f"An error occurred during installation:\n{str(e)}")
            self.btn_install.config(state=tk.NORMAL, bg="#0072CE")

    def run_command(self, cmd):
        self.log(f"> {' '.join(cmd)}")
        # Run process in a hidden background terminal
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )
        
        for line in iter(process.stdout.readline, ''):
            if line:
                self.log(line.strip())
        
        process.stdout.close()
        process.wait()
        if process.returncode != 0:
            raise Exception(f"Command failed with exit code {process.returncode}")

    def create_shortcut(self, target_exe):
        try:
            import win32com.client
            desktop = os.path.join(os.path.expanduser("~"), "Desktop")
            path = os.path.join(desktop, "Hatch Roam Logger.lnk")
            shell = win32com.client.Dispatch("WScript.Shell")
            shortcut = shell.CreateShortCut(path)
            shortcut.Targetpath = target_exe
            shortcut.WorkingDirectory = os.path.dirname(target_exe)
            shortcut.save()
            self.log("Created Desktop shortcut.")
        except Exception:
            self.log("Notice: pywin32 not available, skipping desktop shortcut creation.")


if __name__ == "__main__":
    app = InstallerGUI()
    app.mainloop()
