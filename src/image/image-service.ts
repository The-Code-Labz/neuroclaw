import { resolveXaiCredentials } from './xai-credentials';

const IMAGE_MODEL    = 'grok-imagine-image';
const IMAGE_MODEL_HD = 'grok-imagine-image-quality';

export interface ImageResult {
  url: string;
}

// Calls xAI's /images/generations endpoint directly using credentials from the
// Hermes auth store (~/.hermes/auth.json). Bypasses the Hermes proxy because
// that proxy's xAI adapter does not forward /images/generations requests.
export async function generateImage(
  prompt: string,
  quality: 'standard' | 'hd' = 'standard',
): Promise<ImageResult> {
  const creds = await resolveXaiCredentials();
  if (!creds) {
    throw new Error(
      'No xAI credentials found. ' +
      'Authenticate with `hermes auth add xai-oauth --type oauth` or set XAI_API_KEY.',
    );
  }

  const model = quality === 'hd' ? IMAGE_MODEL_HD : IMAGE_MODEL;

  const res = await fetch(`${creds.baseUrl}/images/generations`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${creds.bearer}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model, prompt, n: 1 }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`xAI image generation failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const body = await res.json() as { data?: Array<{ url?: string; b64_json?: string }> };
  const first = body.data?.[0];

  if (first?.url) return { url: first.url };

  if (first?.b64_json) {
    return { url: `data:image/png;base64,${first.b64_json}` };
  }

  throw new Error('xAI image generation returned no image data');
}
