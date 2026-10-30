import copy
import threading
from settings import private_json, read_private
from market import timestamp
from universe import valid_symbol


class State:
    def __init__(self, directory):
        self.file = directory / "market-cache.json"
        self.history_dir = directory / "history"
        self.history_dir.mkdir(exist_ok=True, mode=0o700)
        self.saved_history = {}
        self.condition = threading.Condition()
        self.version = 0
        self.data = {"quotes": {}, "snapshotQuotes": {}, "history": {}, "options": None, "holdingGreeks": {}}
        if self.file.exists():
            try:
                saved = read_private(self.file)
                for key in self.data:
                    if key in saved:
                        self.data[key] = saved[key]
            except (ValueError, OSError):
                pass
        self.clear_risk_fields()
        self.data["status"] = {"state": "starting", "connected": False, "lastFrameAt": None}
        for file in self.history_dir.glob("*.json"):
            if valid_symbol(file.stem):
                try:
                    self.data["history"][file.stem] = read_private(file)
                except (ValueError, OSError):
                    pass

    def clear_risk_fields(self):
        with self.condition:
            self.data['holdingGreeks'] = {}
            for key in ('quotes', 'snapshotQuotes'):
                for row in self.data[key].values():
                    row.pop('fieldTimes', None)

    def update(self, key, value):
        with self.condition:
            self.data[key] = copy.deepcopy(value)
            self.version += 1
            self.condition.notify_all()

    def status(self, **values):
        with self.condition:
            self.data["status"].update(values)
            self.version += 1
            self.condition.notify_all()

    def view(self, keys=None):
        with self.condition:
            return copy.deepcopy({key: self.data[key] for key in keys} if keys else self.data)

    def save(self):
        with self.condition:
            for symbol, value in self.data["history"].items():
                if value.get("receivedAt") != self.saved_history.get(symbol):
                    private_json(self.history_dir / (symbol + ".json"), value)
                    self.saved_history[symbol] = value.get("receivedAt")
        private_json(self.file, self.view(["quotes", "snapshotQuotes", "options", "holdingGreeks", "status"]))

    def event(self):
        value = self.view(["quotes", "options", "status"])
        return {k: value[k] for k in ("quotes", "options", "status")}
