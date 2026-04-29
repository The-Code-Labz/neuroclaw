import dotenv from 'dotenv';
dotenv.config();

// Getters so live dotenv reloads (from config-watcher) propagate immediately
export const config = {
  get voidai() {
    return {
      apiKey:  process.env.VOIDAI_API_KEY  ?? '',
      baseURL: process.env.VOIDAI_BASE_URL ?? 'https://api.voidai.app/v1',
      model:   process.env.VOIDAI_MODEL    ?? 'gpt-5.1',
    };
  },
  get dashboard() {
    return {
      port:  parseInt(process.env.DASHBOARD_PORT ?? '3141', 10),
      token: process.env.DASHBOARD_TOKEN ?? 'change-me',
    };
  },
  get db() {
    return { path: process.env.DB_PATH ?? './neuroclaw.db' };
  },
};
