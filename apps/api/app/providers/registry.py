from app.providers.anthropic import AnthropicAdapter
from app.providers.base import LlmAdapter
from app.settings import settings


class UnsupportedProviderError(Exception):
    pass


class ProviderNotConfiguredError(Exception):
    pass


def provider_is_available(provider_id: str) -> bool:
    key = {
        "anthropic": settings.anthropic_api_key,
        "deepseek": settings.deepseek_api_key,
    }.get(provider_id)
    return key is not None and bool(key.get_secret_value().strip())


def create_llm_adapter(provider_id: str) -> LlmAdapter:
    if provider_id == "anthropic":
        if settings.anthropic_api_key is None or not provider_is_available(provider_id):
            raise ProviderNotConfiguredError(
                "Anthropic API key is not configured."
            )

        return AnthropicAdapter(
            api_key=settings.anthropic_api_key.get_secret_value(),
        )

    if provider_id == "deepseek":
        if settings.deepseek_api_key is None or not provider_is_available(provider_id):
            raise ProviderNotConfiguredError("DeepSeek API key is not configured.")
        return AnthropicAdapter(
            api_key=settings.deepseek_api_key.get_secret_value(),
            provider_id="deepseek",
            base_url="https://api.deepseek.com/anthropic",
            # The common message format does not retain reasoning blocks.
            disable_thinking=True,
        )

    raise UnsupportedProviderError(
        f"Unsupported LLM provider: {provider_id}"
    )
