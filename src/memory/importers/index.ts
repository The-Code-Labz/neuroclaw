import { parseChatGPT }    from './chatgpt';
import { parseClaudeCode } from './claude-code';
import { parseGemini }     from './gemini';
import { parseGeneric }    from './generic';
import type { ImportedConversation, ImportSource } from './types';

export type { ImportedConversation, ImportedExchange, ImportSource } from './types';

export function parse(buffer: Buffer, source: ImportSource): ImportedConversation[] {
  switch (source) {
    case 'chatgpt':     return parseChatGPT(buffer);
    case 'claude_code': return parseClaudeCode(buffer);
    case 'gemini':      return parseGemini(buffer);
    case 'generic':     return parseGeneric(buffer);
    default:            return [];
  }
}
