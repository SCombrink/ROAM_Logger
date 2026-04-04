# workers.py
import time
import re
import os
import queue
import json
import speech_recognition as sr
from PySide6.QtCore import QThread, Signal
from playwright.sync_api import sync_playwright
from simple_roam_populator import execute_population, run_bulk_population

class PersistentCopilotWorker(QThread):
    finished_signal = Signal(str)
    
    def __init__(self, headless=True):
        super().__init__()
        self.command_queue = queue.Queue()
        self.running = True
        self.headless = headless
        
    def run(self):
        with sync_playwright() as p:
            user_data_dir = os.path.expanduser("~/.roam_helper/playwright_profile")
            browser = p.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                channel="msedge", 
                headless=self.headless, 
                args=['--start-maximized'],
                no_viewport=True
            )
            
            page = browser.pages[0]
            try:
                page.goto("https://m365.cloud.microsoft/chat/")
                input_selector = '#m365-chat-editor-target-element, textarea, [contenteditable="true"]'
                try:
                    page.wait_for_selector(input_selector, timeout=8000)
                except:
                    hatch_account_selector = "text=/.*@hatch.*/i"
                    if page.locator(hatch_account_selector).is_visible():
                        page.locator(hatch_account_selector).first.click()
                    page.wait_for_selector(input_selector, timeout=30000)
            except:
                pass

            while self.running:
                try:
                    cmd = self.command_queue.get(timeout=0.5)
                    if cmd['action'] == 'prompt':
                        prompt_text = cmd['text']
                        try:
                            page.locator(input_selector).first.click()
                            page.keyboard.insert_text(prompt_text)
                            page.wait_for_timeout(1000) 
                            page.keyboard.press("Enter")
                            page.wait_for_timeout(500)
                            
                            page.evaluate("""() => {
                                return new Promise((resolve) => {
                                    let attempts = 0;
                                    const checkButton = setInterval(() => {
                                        attempts++;
                                        const btn = document.querySelector('button[title="Submit message"], button[aria-label="Submit message"], button[aria-label="Send"], button[data-testid="submit-button"]');
                                        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
                                            clearInterval(checkButton);
                                            btn.click(); 
                                            resolve(true);
                                        }
                                        if (attempts > 75) {
                                            clearInterval(checkButton);
                                            resolve(false);
                                        }
                                    }, 200);
                                });
                            }""")
                            
                            page.wait_for_timeout(500)
                            try:
                                page.wait_for_url(re.compile(r".*/conversation/.*"), timeout=15000)
                            except: pass

                            target_selector = '[data-testid="markdown-reply"], .fai-ChatMessage__content, [role="presentation"] div[dir="auto"]'
                            last_length = 0
                            stable_count = 0
                            final_text = ""
                            
                            for _ in range(60): 
                                current_text = page.evaluate(f"""() => {{
                                    const msgs = document.querySelectorAll('{target_selector}');
                                    if (msgs.length > 0) {{ return msgs[msgs.length - 1].innerText; }}
                                    return "";
                                }}""")
                                if current_text and len(current_text.strip()) > 0:
                                    if len(current_text) == last_length: stable_count += 1
                                    else: stable_count = 0 
                                    last_length = len(current_text)
                                    final_text = current_text
                                if stable_count >= 3 and len(final_text) > 2: break
                                time.sleep(1)
                            
                            self.finished_signal.emit(final_text.strip() if final_text else "Error: Extraction Timeout.")
                        except Exception as e:
                            self.finished_signal.emit(f"Automation failed: {str(e)[:100]}...")
                            
                    elif cmd['action'] == 'close':
                        self.running = False
                        break
                except queue.Empty:
                    continue
            browser.close()

class VoiceWorker(QThread):
    finished_signal = Signal(str, bool, str) 
    processing_signal = Signal()
    ready_signal = Signal()
    def __init__(self):
        super().__init__()
        self.running = True
    def run(self):
        recognizer = sr.Recognizer()
        recognizer.pause_threshold = 3.0 
        audio_path = os.path.expanduser("~/.roam_helper/last_recording.wav")
        with sr.Microphone() as source:
            recognizer.adjust_for_ambient_noise(source, duration=0.4)
            self.ready_signal.emit() 
            while self.running:
                try:
                    audio = recognizer.listen(source, timeout=1, phrase_time_limit=None)
                    self.processing_signal.emit()
                    os.makedirs(os.path.dirname(audio_path), exist_ok=True)
                    with open(audio_path, "wb") as f: f.write(audio.get_wav_data())
                    text = recognizer.recognize_google(audio)
                    self.finished_signal.emit(text, True, audio_path)
                    self.running = False 
                    break
                except sr.WaitTimeoutError:
                    if not self.running: break 
                    continue
                except sr.UnknownValueError:
                    self.finished_signal.emit("", True, "") 
                    self.running = False
                    break
                except Exception as e:
                    if self.running:
                        self.finished_signal.emit(f"Voice error: {str(e)}", False, "")
                        self.running = False
                        break
    def stop(self): self.running = False

class WorkerThread(QThread):
    progress = Signal(str)
    finished_success = Signal(bool, str) 
    def __init__(self, headless=True):
        super().__init__()
        self.command_queue = queue.Queue()
        self._is_cancelled = False 
        self.headless = headless
    def cancel(self): 
        self._is_cancelled = True
    def run(self):
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="msedge", headless=self.headless)
                context = browser.new_context(ignore_https_errors=True)
                page = context.new_page()
                target_url = "https://ipassm/NetForms/#/new/ROAM-Online"
                
                while True:
                    if self._is_cancelled:
                        break
                    try:
                        cmd = self.command_queue.get(timeout=0.5)
                        if cmd['action'] == 'preload':
                            try:
                                page.goto(target_url, timeout=60000)
                            except Exception:
                                pass
                        elif cmd['action'] == 'submit':
                            obs = cmd['observation']
                            success, error_msg = execute_population(page, obs, self.progress.emit, lambda: self._is_cancelled)
                            if not self._is_cancelled: 
                                self.finished_success.emit(success, error_msg)
                            break
                        elif cmd['action'] == 'close':
                            break
                    except queue.Empty:
                        continue
                
                context.close()
                browser.close()
        except Exception as e:
            if not self._is_cancelled: 
                self.finished_success.emit(False, str(e))

class BulkWorkerThread(QThread):
    progress = Signal(str)
    update_counts = Signal(int, int, int, int) 
    finished_bulk = Signal(int, int, bool) 
    def __init__(self, observations):
        super().__init__()
        self.observations = observations
        self._is_cancelled = False
    def cancel(self): self._is_cancelled = True
    def run(self):
        try:
            with sync_playwright() as playwright:
                success_count, fail_count = run_bulk_population(playwright, self.observations, self.progress.emit, self.update_counts.emit, cancel_check=lambda: self._is_cancelled)
                self.finished_bulk.emit(success_count, fail_count, self._is_cancelled)
        except Exception as e:
            self.finished_bulk.emit(0, len(self.observations), self._is_cancelled)
