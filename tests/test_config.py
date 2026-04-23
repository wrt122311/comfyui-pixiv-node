import json
import pytest
from pathlib import Path
from config import Config


def test_get_refresh_token_returns_none_when_no_file(tmp_path):
    c = Config(tmp_path / "config.json")
    assert c.get_refresh_token() is None


def test_save_and_get_refresh_token(tmp_path):
    c = Config(tmp_path / "config.json")
    c.save_refresh_token("my_token_123")
    assert c.get_refresh_token() == "my_token_123"


def test_persists_across_instances(tmp_path):
    path = tmp_path / "config.json"
    Config(path).save_refresh_token("abc123")
    assert Config(path).get_refresh_token() == "abc123"


def test_save_preserves_existing_keys(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"other_key": "value"}))
    Config(path).save_refresh_token("tok")
    data = json.loads(path.read_text())
    assert data["other_key"] == "value"
    assert data["refresh_token"] == "tok"
