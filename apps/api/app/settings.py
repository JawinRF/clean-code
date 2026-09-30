from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    postgres_host: str
    postgres_port: int
    postgres_user: str
    postgres_db: str
    postgres_password: SecretStr

    anthropic_api_key: SecretStr | None = None
    deepseek_api_key: SecretStr | None = None
    subagent_concurrency: int = Field(default=4, ge=1, le=8)
    subagent_max_per_run: int = Field(default=8, ge=1, le=32)
    subagent_timeout_seconds: int = Field(default=900, ge=30, le=3600)

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

settings = Settings()
