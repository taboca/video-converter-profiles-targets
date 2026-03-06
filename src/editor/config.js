import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

let legacyConfig = {};
try {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  legacyConfig = JSON.parse(raw);
} catch (_error) {
  legacyConfig = {};
}

export const openAIConfig = {
  apiKey:
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_KEY ||
    process.env.OPENAI_API_KEY_PRIMARY ||
    legacyConfig.OPENAI_API_KEY ||
    '',
  legacyApiKey: typeof legacyConfig.OLD_KEY === 'string' ? legacyConfig.OLD_KEY : null,
};
