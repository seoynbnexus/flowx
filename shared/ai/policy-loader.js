import fs from 'fs';
import { load as yamlLoad } from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let policy = null;
let policyPath = null;

export function loadPolicy() {
  policyPath = process.env.AI_SAFETY_POLICY_PATH || path.join(__dirname, 'ai-safety-policy.yaml');
  try {
    const raw = fs.readFileSync(policyPath, 'utf8');
    policy = yamlLoad(raw);
    return policy;
  } catch (error) {
    console.error('Failed to load AI safety policy:', error.message);
    policy = getDefaultPolicy();
    return policy;
  }
}

export function getPolicy() {
  if (!policy) loadPolicy();
  return policy;
}

export function reloadPolicy() {
  policy = null;
  return loadPolicy();
}

function getDefaultPolicy() {
  return {
    categories: {},
    limits: { max_prompt_length: 1000 },
    abuse: { violation_threshold: 5, violation_window_hours: 24, auto_block_generation: true, auto_block_account_at: 10 },
  };
}

export function validatePrompt(prompt) {
  const p = getPolicy();
  if (!prompt || typeof prompt !== 'string') {
    return { blocked: true, reason: 'Invalid prompt', category: 'validation', severity: 'high' };
  }

  const maxLen = p.limits?.max_prompt_length || 1000;
  if (prompt.length > maxLen) {
    return { blocked: true, reason: `Prompt exceeds ${maxLen} character limit`, category: 'limits', severity: 'medium' };
  }

  for (const [category, rules] of Object.entries(p.categories || {})) {
    if (!rules.enabled) continue;

    if (rules.keywords?.length) {
      const lower = prompt.toLowerCase();
      for (const keyword of rules.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          return {
            blocked: true,
            reason: `Prompt violates content policy: ${category}`,
            category,
            severity: rules.severity || 'high',
            action: rules.action || 'block',
            matched: keyword,
          };
        }
      }
    }

    if (rules.patterns?.length) {
      for (const pattern of rules.patterns) {
        try {
          const regexMatch = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
          if (regexMatch) {
            const regex = new RegExp(regexMatch[1], regexMatch[2] || 'i');
            if (regex.test(prompt)) {
              return {
                blocked: true,
                reason: `Prompt violates content policy: ${category}`,
                category,
                severity: rules.severity || 'high',
                action: rules.action || 'block',
              };
            }
          }
        } catch {
          continue;
        }
      }
    }
  }

  return { blocked: false };
}

export function validateOutput(content) {
  return validatePrompt(content);
}
