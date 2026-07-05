import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../config';

export const LIVEKIT_ROOM_NAME = 'neuroclaw-neuro-room';

export async function generateRoomToken(identity: string, ttlSec = 3600): Promise<string> {
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    ttl: ttlSec,
  });
  at.addGrant({
    roomJoin:     true,
    room:         LIVEKIT_ROOM_NAME,
    canPublish:   true,
    canSubscribe: true,
  });
  return at.toJwt();
}

export interface RoomParticipant {
  identity: string;
  name:     string;
  state:    string;
}

export async function getRoomParticipants(): Promise<RoomParticipant[]> {
  try {
    const svc  = new RoomServiceClient(config.livekit.url, config.livekit.apiKey, config.livekit.apiSecret);
    const list = await svc.listParticipants(LIVEKIT_ROOM_NAME);
    return list.map(p => ({
      identity: p.identity,
      name:     p.name,
      state:    p.state?.toString() ?? 'unknown',
    }));
  } catch {
    return [];
  }
}
