# models.py
import json
from datetime import datetime

class ROAMObservation:
    def __init__(self, **kwargs):
        self.list_cats = [
            "Access Breach", "Barricading", "Behaviour / General Conduct", "Caught Between", "Chemical", 
            "Collision", "Confined Space", "Contact With", "Cyber security", "Electrical", "Equipment Failure",
            "Ergonomics / Manual Handling", "Excavation", "Explosion", "Fall from Above", 
            "Fall from Above Objects", "Fall from Above Slips/Trips/Falls", "Fire", "Fire Prevention / Protection", 
            "Foreign Body", "Hazardous Substances", "Health/Medical/Disease", "Housekeeping", "Lifting and Rigging",
            "Lockout/Tagout, Danger Tag/Isolation", "Manual Handling", "Mobile Equipment", "Motor Vehicle", 
            "Noise", "Over/Near Water", "Permit to Work", "Personal Protective Equipment", "Procedure Breach", 
            "Quality Assurance/Quality Control", "Security", "Sharp Objects", "Signage", "Stacking Storage", 
            "Sustainability", "Thermal Stress (Hot / Cold)", "Travel", "Unguarded Equipment", "Weather Conditions",
            "Wildlife", "Work at Heights", "Workstation Ergonomics",
        ]
        self.text_project = kwargs.get("text_project", "Hatch Global (Project View)")
        self.text_location = kwargs.get("text_location", "Johannesburg")
        self.text_office = kwargs.get("text_office", "58 Emerald Parkway Road, Greenstone Hill")
        self.text_exact_loc = kwargs.get("text_exact_loc", "office")
        self.observation_text = kwargs.get("observation_text", "")
        self.action_text = kwargs.get("action_text", "")
        self.category_text = kwargs.get("category_text", "")
        self.card_type = kwargs.get("card_type", "VFL - Field Safety Observation Card, Yellow Card")
        
        self.office_location = kwargs.get("office_location", "Hatch office")
        self.contractor_work = kwargs.get("contractor_work", "No")
        self.work_hours = kwargs.get("work_hours", "No")
        self.obs_type = kwargs.get("obs_type", "Behaviour")
        self.obs_safe = kwargs.get("obs_safe", "Safe")
        
        self.timestamp = datetime.now().isoformat()
        obs_now = datetime.now()
        self.obs_date = kwargs.get("obs_date", obs_now.strftime("%d/%b/%y"))
        self.obs_time = kwargs.get("obs_time", obs_now.strftime("%H:%M"))

    def to_dict(self):
        return {
            "text_project": self.text_project, "text_location": self.text_location,
            "text_office": self.text_office, "text_exact_loc": self.text_exact_loc,
            "observation_text": self.observation_text, "action_text": self.action_text,
            "category_text": self.category_text, "card_type": self.card_type,
            "office_location": self.office_location, "contractor_work": self.contractor_work,
            "work_hours": self.work_hours, "obs_type": self.obs_type, "obs_safe": self.obs_safe,
            "timestamp": self.timestamp, "obs_date": self.obs_date, "obs_time": self.obs_time,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(**data)

    def to_json(self, filepath: str):
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=4)

    @classmethod
    def from_json(cls, filepath: str):
        with open(filepath, "r", encoding="utf-8") as f:
            return cls.from_dict(json.load(f))