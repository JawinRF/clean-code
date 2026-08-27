from app.providers.anthropic import AnthropicAdapter
from app.providers.base import LlmAdapter
from app.settings import settings


class UnsupportedProviderError(Exception):
    pass


class ProviderNotConfiguredError(Exception):
    pass


def create_llm_adapter(provider_id: str) -> LlmAdapter:
    if provider_id == "anthropic":
        if settings.anthropic_api_key is None:
            raise ProviderNotConfiguredError(
                "Anthropic API key is not configured."
            )

        return AnthropicAdapter(
            api_key=settings.anthropic_api_key.get_secret_value(),
        )

    raise UnsupportedProviderError(
        f"Unsupported LLM provider: {provider_id}"
    )
