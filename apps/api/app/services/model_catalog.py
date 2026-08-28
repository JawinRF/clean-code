from functools import cache
from pathlib import Path

from pydantic import ValidationError

from app.schemas import ModelCatalogResponse


MODEL_CATALOG_PATH = (
    Path(__file__).resolve().parents[2]
    / "config"
    / "models.json"
)


class ModelCatalogConfigurationError(RuntimeError):
    pass


@cache
def load_model_catalog() -> ModelCatalogResponse:
    try:
        catalog_json = MODEL_CATALOG_PATH.read_text(encoding="utf-8")
    except OSError as error:
        raise ModelCatalogConfigurationError(
            "The model catalog could not be read."
        ) from error

    try:
        return ModelCatalogResponse.model_validate_json(catalog_json)
    except ValidationError as error:
        raise ModelCatalogConfigurationError(
            "The model catalog is invalid."
        ) from error


def model_is_configured(
    catalog: ModelCatalogResponse,
    *,
    provider_id: str,
    model_id: str,
) -> bool:
    return any(
        provider.id == provider_id
        and any(model.id == model_id for model in provider.models)
        for provider in catalog.providers
    )
