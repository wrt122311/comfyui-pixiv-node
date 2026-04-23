import json
from pathlib import Path


class Config:
    def __init__(self, path=None):
        self.path = Path(path) if path else Path(__file__).parent / "config.json"

    def get_refresh_token(self):
        if not self.path.exists():
            return None
        return json.loads(self.path.read_text()).get("refresh_token")

    def save_refresh_token(self, token: str):
        data = json.loads(self.path.read_text()) if self.path.exists() else {}
        data["refresh_token"] = token
        self.path.write_text(json.dumps(data))
