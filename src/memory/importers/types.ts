export interface ImportedExchange {
  user:      string;
  assistant: string;
}

export interface ImportedConversation {
  id:        string;
  title?:    string;
  exchanges: ImportedExchange[];
}

export type ImportSource = 'chatgpt' | 'claude_code' | 'gemini' | 'generic';
