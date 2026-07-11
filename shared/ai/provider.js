const PROVIDER = process.env.AI_PROVIDER || 'gemini';
const API_KEY = process.env.AI_API_KEY;
const MODEL = process.env.AI_MODEL || 'gemini-2.0-flash';
const TEMPERATURE = parseFloat(process.env.AI_TEMPERATURE || '0.7');
const MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS || '1024', 10);

const PROVIDER_FACTORIES = {
  gemini: async () => {
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    return new ChatGoogleGenerativeAI({
      model: MODEL,
      apiKey: API_KEY,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_TOKENS,
    });
  },

  openai: async () => {
    const { ChatOpenAI } = await import('@langchain/openai');
    return new ChatOpenAI({
      model: MODEL || 'gpt-4o-mini',
      apiKey: API_KEY,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
      configuration: {
        baseURL: process.env.OPENAI_BASE_URL,
      },
    });
  },

  anthropic: async () => {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({
      model: MODEL || 'claude-3-haiku-20240307',
      apiKey: API_KEY,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
    });
  },

  groq: async () => {
    const { ChatGroq } = await import('@langchain/groq');
    return new ChatGroq({
      model: MODEL || 'llama3-70b-8192',
      apiKey: API_KEY,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
    });
  },
};

let modelInstance = null;

export async function getLLM() {
  if (modelInstance) return modelInstance;

  const factory = PROVIDER_FACTORIES[PROVIDER];
  if (!factory) {
    throw new Error(`Unknown AI provider: ${PROVIDER}. Supported: ${Object.keys(PROVIDER_FACTORIES).join(', ')}`);
  }

  modelInstance = await factory();
  return modelInstance;
}

export function resetLLM() {
  modelInstance = null;
}

export function getProviderInfo() {
  return {
    provider: PROVIDER,
    model: MODEL,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
  };
}
