# Hatch ROAM Logger

## Installation

1. Download the `roaminstaller.exe` file.
2. Double-click `roaminstaller.exe` to run it.
3. The installer will extract the application files to your `Documents\Hatch Roam Logger` folder.
4. It will automatically download and install the necessary background dependencies (Python libraries and the Playwright browser).
5. Once complete, a shortcut will be created on your Desktop.

## Usage

1. **Open the App:** Double-click the "Hatch Roam Logger" shortcut on your Desktop.
2. **Describe Observation:** Use the text box at the top to type your observation naturally, or click "Start Recording" to dictate it using your voice.
3. **Use AI:** Click "Submit Prompt". The AI will analyze your description and automatically fill out the form fields below.
4. **Review & Edit:** Check the filled fields. You can manually adjust any dropdowns, toggles, or text fields if needed.
5. **Submit:** Click "Submit Observation" at the bottom to send the data to the ROAM system.

## Developer: How to Build the Installer

To package the application into a single `roaminstaller.exe` file, follow these simple steps:


1. **Compile the Main App:** Build your main application as a directory (not onefile) using PyInstaller. Open your terminal in the directory containing `main.py` and run:

    python -m PyInstaller --noconfirm --windowed --icon="roamicon.ico" --add-data "hatch_logo.png;." --add-data "roamicon.ico;." --name "Hatch Roam Logger" main.py

    The compiled application files will be located in the `dist\Hatch Roam Logger` folder.

2. **Prepare the Folder:** Create a folder named `Hatch Roam Logger` in the same directory as `installer.py`.
3. **Add Files:** Copy **all the contents** from the `dist\Hatch Roam Logger` folder (from step 1) into the new `Hatch Roam Logger` folder you just created next to `installer.py`.
4. **Build the Installer:** Open your terminal in the directory containing `installer.py` and run the following command:

    python -m PyInstaller --noconfirm --onefile --windowed --icon="Hatch Roam Logger/roamicon.ico" --add-data "Hatch Roam Logger;Hatch Roam Logger" --name "roaminstaller" installer.py

5. **Locate the Installer:** The finished `roaminstaller.exe` will be located in the `dist` folder.
