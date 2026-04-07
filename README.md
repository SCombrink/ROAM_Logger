# Hatch ROAM Logger

## Setup and API Key

1. **Launch the App:** Open the Hatch ROAM Logger.
2. **Connect AI Copilot:** To enable AI features, you need a Gemini API Key.
   - Click **"Get Key"** to see a QR code and instructions.
   - Visit [aistudio.google.com](https://aistudio.google.com), sign in, and create a free API key.
   - Paste the key into the app and click **"Save Key"**.
3. **Persistence:** Once validated, the key is stored securely in your local app data. You won't need to enter it again unless it becomes invalid.

## Usage

1. **Describe Observation:** Use the AI Copilot chat box at the top. Type your observation naturally or click the microphone 🎤 icon to dictate via voice.
2. **AI Processing:** The AI will analyze your input, infer the correct project, category, and observation details, and automatically populate the form fields below.
3. **Review & Edit:** Review the populated fields. You can manually adjust any dropdowns, toggles, or text fields.
4. **Submit:** Click **"Submit Observation"**.
   - The app will automatically launch Microsoft Edge in the background.
   - It will navigate to the ROAM system, handle the SSO handshake, and fill out the form exactly as required.
   - The browser window is hidden by default.

## Advanced Features

- **Debug Menu:** Press `CTRL + SHIFT + ALT + D` to reveal the secret Debug Settings.
- **Headless Toggle:** In the Debug Settings, you can check "Show browser and automation steps" to see the Edge browser perform the form filling in real-time instead of running in the background.

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
