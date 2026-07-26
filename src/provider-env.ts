/** Conventional provider API-key env vars, for error hints and inspection. */
const PROVIDER_ENV_HINTS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
};

export function expectedProviderEnvVars(provider: string): readonly string[] {
  return (
    PROVIDER_ENV_HINTS[provider] ?? [
      `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`,
    ]
  );
}
