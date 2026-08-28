from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ModelCatalogModel(BaseModel):
    id: str = Field(
        min_length=1,
        max_length=160,
    )
    label: str = Field(
        min_length=1,
        max_length=160,
    )


class ModelCatalogProvider(BaseModel):
    id: str = Field(
        min_length=1,
        max_length=80,
    )
    label: str = Field(
        min_length=1,
        max_length=120,
    )
    models: list[ModelCatalogModel]

    @model_validator(mode="after")
    def model_ids_are_unique(self) -> "ModelCatalogProvider":
        model_ids = [model.id for model in self.models]

        if len(model_ids) != len(set(model_ids)):
            raise ValueError(
                "Model IDs must be unique inside a provider."
            )

        return self


class ModelCatalogResponse(BaseModel):
    schema_version: Literal[1]
    providers: list[ModelCatalogProvider]

    @model_validator(mode="after")
    def provider_ids_are_unique(self) -> "ModelCatalogResponse":
        provider_ids = [provider.id for provider in self.providers]

        if len(provider_ids) != len(set(provider_ids)):
            raise ValueError("Provider IDs must be unique.")

        return self
