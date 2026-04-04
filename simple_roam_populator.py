# simple_roam_populator.py
import json
import os
from pathlib import Path
from datetime import datetime
from playwright.sync_api import Playwright, sync_playwright

class CancelledError(Exception):
    pass

class ServerOfflineError(Exception):
    pass

class SimpleROAMPopulator:
    """Robust ROAM form populator with explicit SPA waits and cancellation polls"""

    def __init__(self, page, progress_callback=None, cancel_check=None):
        self.page = page
        self.progress_callback = progress_callback
        self.cancel_check = cancel_check
        self.frame = None

    def _log(self, message):
        """Log a message via callback or print"""
        if self.progress_callback:
            self.progress_callback(message)
        else:
            print(message)

    def _check_cancel(self):
        """Throws a silent exception if the PySide window user clicks Cancel"""
        if self.cancel_check and self.cancel_check():
            raise CancelledError("CANCELLED")

    def switch_to_frame(self):
        """Wait for and switch to the ROAM iframe using a polling mechanism to allow fast-fails"""
        self.frame = None # Explicitly reset frame to clear cached states from previous bulk iterations
        self._log("Waiting for form container...")
        iframe = self.page.locator('#e360Frame').first
        
        # Loop to wait for frame so we can continually check for cancel button & popup errors
        for _ in range(45): 
            self._check_cancel()
            
            if self.page.locator("text=Sorry, something went wrong").is_visible():
                raise ServerOfflineError("ROAM server offline. Please try again later")
            
            if iframe.count() > 0 and iframe.is_visible():
                if iframe.content_frame:
                    self.frame = iframe.content_frame
                    self._log("✓ Switched to ROAM iframe")
                    break
            self.page.wait_for_timeout(1000)
        else:
            raise Exception("Timed out waiting for the form to appear. The network might be slow.")
            
        self._log("Waiting for internal SPA inputs to render...")
        for _ in range(45):
            self._check_cancel()
            if self.frame.get_by_role("textbox").count() > 0:
                break
            self.page.wait_for_timeout(1000)
        else:
            raise Exception("Timed out waiting for internal form fields to render.")
            
        self.page.wait_for_timeout(1000) 
        return True

    def _safe_fill(self, index, value, field_name, delay_after_ms=100, type_and_wait=False):
        """Helper to fill a textbox, press Tab to trigger SPA validation, and optionally wait"""
        if not value: return
        self._check_cancel()
        try:
            textbox = self.frame.get_by_role("textbox").nth(index)
            textbox.click()
            
            if type_and_wait:
                # Type the text and wait 1000ms max for the form to self-populate before tabbing
                textbox.fill(value)
                self.page.wait_for_timeout(1000)
                textbox.press("Tab")
            else:
                textbox.fill(value)
                textbox.press("Tab") 
            
            # Built-in delay for fields that trigger heavy SPA self-population
            if delay_after_ms > 0:
                self.page.wait_for_timeout(delay_after_ms)
                
            self._log(f"✓ {field_name} set")
        except Exception as e:
            raise Exception(f"Failed to set {field_name}: {str(e)}")

    def _safe_radio(self, name, click_last=False, field_name="Radio"):
        if not name: return
        self._check_cancel()
        try:
            element = self.frame.get_by_role('radio', name=name)
            if click_last:
                element.last.click()
            else:
                element.first.click()
            self._log(f"✓ {field_name} set to {name}")
        except Exception as e:
            raise Exception(f"Failed to set {field_name}: {str(e)}")

    def _fill_vfl_color(self, index, card_type, field_name="VFL Card Color"):
        """Custom arrow-down mechanism to safely select the VFL color."""
        if not card_type: return
        self._check_cancel()
        try:
            textbox = self.frame.get_by_role("textbox").nth(index)
            textbox.click()
            
            # Type VFL and wait 800ms to open the dropdown
            textbox.fill("VFL")
            self.page.wait_for_timeout(800)

            # Determine arrow down count based on mapping
            card_lower = str(card_type).lower()
            if "design" in card_lower:
                presses = 1
            elif "office" in card_lower:
                presses = 3
            else:
                presses = 2 # Field is default

            # Execute arrow downs
            for _ in range(presses):
                textbox.press("ArrowDown")
                self.page.wait_for_timeout(50) # small pause between keystrokes

            textbox.press("Tab")
            self.page.wait_for_timeout(500)
            
            self._log(f"✓ {field_name} set via arrow keys ({presses} presses)")
        except Exception as e:
            raise Exception(f"Failed to set {field_name}: {str(e)}")

    def populate_all_fields(self, data):
        self._log("Starting ROAM field population...")

        if not self.switch_to_frame():
            raise Exception("Could not access the form iframe.")

        self._safe_fill(2, data.get("project_num"), "Project", type_and_wait=True)
        self._safe_fill(11, data.get("obs_date"), "Date")
        self._safe_fill(12, data.get("obs_time"), "Time")
        self._safe_radio(data.get("contractor_work"), field_name="Contractor Work")
        self._safe_radio(data.get("work_hours"), click_last=True, field_name="Work Hours")
        self._safe_fill(10, data.get("text_exact_loc"), "Exact Location")
        
        self._safe_fill(8, data.get("office_location"), "Office Location", type_and_wait=True)
        self._safe_fill(9, data.get("office_address"), "Office Address", type_and_wait=True)
        self._safe_fill(13, data.get("obs_type"), "Observation Type", type_and_wait=True)
        
        self._safe_fill(14, data.get("obs_status"), "Observation Status")
        self._safe_fill(15, data.get("observation_text"), "Observation Details")
        self._safe_fill(16, data.get("action_text"), "Action Taken")
        
        self._safe_fill(17, data.get("category_text"), "Category", delay_after_ms=100)
        
        # Uses the custom method to execute the ArrowDown trick
        self._fill_vfl_color(18, data.get("vfl_color")) 

        self._log("✅ All fields populated successfully!")
        return True


def execute_population(page, observation_obj, progress_callback=None, cancel_check=None) -> tuple:
    """Execute population on an existing page. Returns (Success_Boolean, Error_Message)"""
    def _log(msg):
        if progress_callback: progress_callback(msg)
        else: print(msg)
    
    try:
        target_url = "https://ipassm/NetForms/#/new/ROAM-Online"
        
        if target_url not in page.url:
            _log(f"Navigating directly to ROAM endpoint...")
            page.goto(target_url, timeout=45000)

        populator = SimpleROAMPopulator(page, progress_callback, cancel_check)

        if observation_obj:
            sample_data = {
                "project_num": observation_obj.text_project,
                "contractor_work": observation_obj.contractor_work,
                "work_hours": observation_obj.work_hours,
                "text_exact_loc": observation_obj.text_exact_loc,
                "location": observation_obj.text_location,
                "office_location": observation_obj.office_location,
                "office_address": observation_obj.text_office,
                "obs_type": observation_obj.obs_type,
                "obs_status": observation_obj.obs_safe,
                "observation_text": observation_obj.observation_text,
                "action_text": observation_obj.action_text,
                "category_text": observation_obj.category_text,
                "vfl_color": observation_obj.card_type, 
                "obs_date": observation_obj.obs_date,
                "obs_time": observation_obj.obs_time,
            }
        else:
            raise Exception("No observation data provided.")

        populator.populate_all_fields(sample_data)
        populator._check_cancel()

        try:
            _log("Clicking Submit on the web form...")
            populator.frame.get_by_role("button").nth(1).click()
            
            for _ in range(5):
                populator._check_cancel()
                if page.locator("text=Sorry, something went wrong").is_visible():
                    raise ServerOfflineError("ROAM server offline. Please try again later")
                page.wait_for_timeout(1000)

        except ServerOfflineError as soe:
            raise soe 
        except Exception as e:
            if "CANCELLED" in str(e): raise e
            _log(f"Warning: Could not automatically click submit on web: {e}")
        
        populator._check_cancel()
        return True, "Success"

    except Exception as e:
        error_msg = str(e)
        if "CANCELLED" in error_msg:
            _log("User cancelled the operation.")
            return False, "CANCELLED"
            
        if "ROAM server offline" in error_msg:
            return False, "ROAM server offline. Please try again later"
            
        _log(f"❌ Error during population: {error_msg}")
        return False, error_msg


def run_bulk_population(playwright: Playwright, observations: list, progress_callback=None, count_callback=None, cancel_check=None) -> tuple:
    """Run BULK ROAM population. Returns (Success_Count, Fail_Count)"""
    def _log(msg):
        if progress_callback: progress_callback(msg)
        else: print(msg)

    success_count = 0
    fail_count = 0
    total = len(observations)

    try:
        _log("Launching Edge Browser for Bulk Processing...")
        browser = playwright.chromium.launch(channel="msedge", headless=False)
        
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()
        target_url = "https://ipassm/NetForms/#/new/ROAM-Online"
        
        populator = SimpleROAMPopulator(page, progress_callback, cancel_check)

        # SSO WARMUP HANDSHAKE: Force an explicit wait to absorb Windows Auth Redirects
        # Without this, VFL 1 tries to fill the form while the background redirect is happening
        _log("Warming up browser connection (SSO Handshake)...")
        try:
            page.goto(target_url, timeout=60000)
            page.wait_for_timeout(4000) 
        except Exception:
            pass # We don't care if it times out here, the loop will cleanly retry

        for i, obs_obj in enumerate(observations):
            if cancel_check and cancel_check():
                break

            # Send purely informational start status
            if count_callback: count_callback(i + 1, total, success_count, fail_count)
            _log(f"--- Processing VFL {i+1} of {total} ---")

            try:
                _log("Navigating to a fresh ROAM form...")
                page.goto(target_url, timeout=45000)

                sample_data = {
                    "project_num": obs_obj.text_project,
                    "contractor_work": obs_obj.contractor_work,
                    "work_hours": obs_obj.work_hours,
                    "text_exact_loc": obs_obj.text_exact_loc,
                    "location": obs_obj.text_location,
                    "office_location": obs_obj.office_location,
                    "office_address": obs_obj.text_office,
                    "obs_type": obs_obj.obs_type,
                    "obs_status": obs_obj.obs_safe,
                    "observation_text": obs_obj.observation_text,
                    "action_text": obs_obj.action_text,
                    "category_text": obs_obj.category_text,
                    "vfl_color": obs_obj.card_type,
                    "obs_date": obs_obj.obs_date,
                    "obs_time": obs_obj.obs_time,
                }

                populator.populate_all_fields(sample_data)
                populator._check_cancel()

                _log("Clicking Submit on the web form...")
                populator.frame.get_by_role("button").nth(1).click()

                for _ in range(5):
                    populator._check_cancel()
                    if page.locator("text=Sorry, something went wrong").is_visible():
                        raise ServerOfflineError("ROAM server offline. Please try again later")
                    page.wait_for_timeout(1000)

                # Hard wait to ensure the SPA Payload successfully dispatches before the loop continues
                page.wait_for_timeout(2500)

                success_count += 1
                _log(f"✅ VFL {i+1} submitted successfully.")

            except ServerOfflineError as soe:
                fail_count += 1
                _log(f"❌ VFL {i+1} failed: Server Offline. Aborting remainder.")
                if count_callback: count_callback(i + 1, total, success_count, fail_count)
                raise soe
            except Exception as e:
                if "CANCELLED" in str(e):
                    break
                fail_count += 1
                _log(f"❌ VFL {i+1} failed: {str(e)}")

            # Update the specific UI counters ONLY after the result is finalized
            if count_callback: 
                count_callback(i + 1, total, success_count, fail_count)

        context.close()
        browser.close()
        return success_count, fail_count

    except Exception as e:
        if "CANCELLED" in str(e):
            _log("Bulk operation cancelled by user.")
        else:
            _log(f"❌ Critical Bulk Error: {str(e)}")
        try: browser.close()
        except: pass
        return success_count, fail_count
