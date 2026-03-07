import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { env } from '../auth.js';

export interface LLMResult {
  name?: string;
  categoryId?: string;
  type?: string;
  userNotes?: string;
  tagIds?: string[];
}

export async function runPreprocessPrompt(
  systemPrompt: string,
  txJson: string
): Promise<{ result: LLMResult; provider: string; model: string }> {
  const llmModel = env('LLM_MODEL');
  const colonIndex = llmModel.indexOf(':');
  if (colonIndex === -1) throw new Error(`LLM_MODEL must be in format "provider:modelId", got: ${llmModel}`);
  const provider = llmModel.slice(0, colonIndex);
  const modelId = llmModel.slice(colonIndex + 1);

  const model = provider === 'anthropic' ? anthropic(modelId) : openai(modelId);
  const { text } = await generateText({ model, system: systemPrompt, prompt: txJson });

  const match = text.match(/```json\n([\s\S]+?)\n```/);
  const result = JSON.parse(match?.[1] ?? text) as LLMResult;
  return { result, provider, model: modelId };
}
